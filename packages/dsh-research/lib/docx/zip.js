/**
 * dsh-research — the ZIP container, hand-written.
 *
 * A `.docx` is an OPC package, which is a ZIP. This module exists because the
 * constraint that produced this whole writer is **no dependency and no child
 * process**: `zlib.deflateRawSync` is core Node, so the compression is a core
 * call while the container around it is forty lines of little-endian fields.
 * Nothing here knows what a document is.
 *
 * Four rules, each of which decides whether Word opens the file at all:
 *
 *   1. **The CRC-32 is right or the file is refused.** Word validates the
 *      central directory's CRC against the decompressed bytes; a wrong table or a
 *      wrong final XOR is a "the file is corrupt" dialog with no clue in it. The
 *      table below is the standard reflected polynomial, built once.
 *   2. **The timestamp is FIXED.** The local headers carry DOS date/time fields,
 *      and a real clock inside them would make two builds of one input differ in
 *      bytes - which is the determinism this package promises. 1980-01-01
 *      00:00:00 is the DOS epoch and the value every reproducible build writes.
 *   3. **The entry order is sorted.** Names decide the order, not the caller's
 *      Map insertion order, so the offsets in the central directory cannot move
 *      under a reordering of the writer's own code.
 *   4. **An entry never claims a feature it does not use.** No ZIP64, no data
 *      descriptors, no encryption: a document is small, the sizes are known
 *      before the header is written, and a reader that only handles the plain
 *      case is a reader that reads what we wrote.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * The DOS stamp every entry carries: 1980-01-01 00:00:00.
 *
 * Fixed rather than clocked, because the bytes of a document must depend only on
 * its input. A ZIP timestamp is metadata a reader never shows for a `.docx`.
 */
export const DOS_TIME = 0
export const DOS_DATE = 0x0021

/** The method this writer uses. `deflate` for everything, since the input is text. */
const METHOD_DEFLATE = 8

/** The four-byte signatures, by name, so no magic number appears twice. */
const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50

/** A ZIP is a byte format, not a text one: this is the only encoding in play. */
const UTF8_FLAG = 0x0800

/** The CRC-32 table, built once. Reflected polynomial 0xedb88320, as the format pins. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * The CRC-32 of a buffer, as the ZIP format defines it: initial value all ones,
 * reflected, final XOR all ones.
 */
export function crc32(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A ZIP name, normalised: forward slashes, and no leading slash. */
function entryName(path) {
  return String(path).replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * Pack a set of entries into a ZIP.
 *
 * @param entries - a Map of name to Buffer, or an array of `[name, Buffer]`.
 * @returns the archive, as a Buffer.
 */
export function packZip(entries) {
  const pairs = [...(entries instanceof Map ? entries.entries() : entries ?? [])].map(([name, content]) => [
    entryName(name),
    Buffer.isBuffer(content) ? content : Buffer.from(content ?? ''),
  ])
  // Sorted by name, so the archive's layout is a function of its contents.
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))

  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of pairs) {
    const compressed = deflateRawSync(content, { level: 9 })
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_SIGNATURE, 0)
    header.writeUInt16LE(20, 4) // version needed: 2.0, which is all this format uses
    header.writeUInt16LE(UTF8_FLAG, 6)
    header.writeUInt16LE(METHOD_DEFLATE, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc32(content), 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28) // no extra field: every size is already known
    locals.push(header, Buffer.from(name, 'utf8'), compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc32(content), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    centrals.push(central, Buffer.from(name, 'utf8'))

    offset += header.length + name.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_SIGNATURE, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // the disk the directory starts on
  end.writeUInt16LE(pairs.length, 8)
  end.writeUInt16LE(pairs.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // no archive comment: the comment is not ours to use
  return Buffer.concat([...locals, directory, end])
}

/**
 * Walk a ZIP's central directory.
 *
 * The directory is what is read, never the local headers: it is the one
 * structure a writer always completes, and an entry missing from it is an entry a
 * reader is right to ignore.
 */
function readDirectory(buffer) {
  let end = -1
  const firstPossible = Math.max(0, buffer.length - 65557)
  for (let index = buffer.length - 22; index >= firstPossible; index -= 1) {
    if (buffer.readUInt32LE(index) === END_SIGNATURE) {
      end = index
      break
    }
  }
  if (end === -1) throw new Error('not a ZIP: no end-of-central-directory record')
  const count = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('not a ZIP: entry ' + index + ' has no central header')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Read a ZIP into its entries.
 *
 * A malformed archive is a refusal with the reason, because a `.docx` that cannot
 * be read back is a document nobody can open - and the message is what a caller
 * has to work with.
 */
export function unpackZip(buffer) {
  const archive = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const files = new Map()
  for (const entry of readDirectory(archive)) {
    if ((entry.flags & 0x0001) !== 0) throw new Error('this ZIP entry is encrypted: ' + entry.name)
    const localNameLength = archive.readUInt16LE(entry.localOffset + 26)
    const localExtraLength = archive.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + localNameLength + localExtraLength
    const raw = archive.subarray(start, start + entry.compressedSize)
    let bytes = null
    try {
      bytes = entry.method === 0 ? Buffer.from(raw) : entry.method === METHOD_DEFLATE ? inflateRawSync(raw) : null
    } catch (err) {
      // A damaged deflate stream is a refusal that names the entry, because "Z_DATA_ERROR"
      // on its own says nothing about which part of the package is unreadable.
      throw new Error('ZIP entry ' + entry.name + ' does not decompress: ' + (err && err.message ? err.message : String(err)))
    }
    if (bytes === null) throw new Error('this ZIP uses compression method ' + entry.method + ', which is not deflate: ' + entry.name)
    if (bytes.length !== entry.size) throw new Error('ZIP entry ' + entry.name + ' is ' + bytes.length + ' bytes, its directory says ' + entry.size)
    // The check the whole file hangs on: Word reads the decompressed bytes and
    // refuses the document when this does not match, so it is verified on the way
    // in rather than trusted.
    if (crc32(bytes) !== entry.crc) throw new Error('ZIP entry ' + entry.name + ' fails its CRC-32')
    files.set(entry.name, bytes)
  }
  return files
}

/** How long a ZIP's bytes take to say whether they decode as UTF-8. */
function decodesAsUtf8(buffer) {
  if (buffer.includes(0)) return false
  return !buffer.toString('utf8').includes('\uFFFD')
}

/**
 * The text of a part, or ''.
 *
 * OPC part names are ASCII by definition, so a name that does not decode is a
 * name nothing wrote - and the caller reports the missing part rather than
 * printing mojibake into a document.
 */
export function partText(files, name) {
  const key = entryName(name)
  if (!(files instanceof Map) || !files.has(key)) return ''
  const bytes = files.get(key)
  return decodesAsUtf8(bytes) ? bytes.toString('utf8') : ''
}

/** The names of every entry, sorted, for a report or for a name check. */
export function partNames(files) {
  return [...(files instanceof Map ? files.keys() : [])].sort()
}
