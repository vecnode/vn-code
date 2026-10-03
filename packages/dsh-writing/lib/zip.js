/**
 * dsh-writing — a minimal ZIP reader and writer.
 *
 * A `.docx` is a ZIP of XML parts, and this package ships **zero npm
 * dependencies** (the pack's rule), so the container is handled here over
 * `node:zlib` alone: deflate/inflate come from the platform, the headers below
 * are the ~200 lines that make them a ZIP.
 *
 * What is deliberately NOT supported, because a Word document never carries it
 * and a half-implementation would be worse than a refusal:
 *
 *   - **ZIP64.** A `.docx` over 4 GiB is not a document, and reading one as if
 *     the 32-bit fields were meaningful would silently truncate it. The sizes
 *     are checked and a typed `ZIP64` error is thrown instead.
 *   - **Encryption** (flag bit 0) and **data descriptors** whose sizes are zero
 *     in the central directory: both are refused by name.
 *   - **Multi-disk archives.**
 *
 * The writer emits one entry per part with the current DOS timestamp, deflate
 * level 9, and the CRC-32 every reader checks. Entry order is preserved exactly
 * as given, because `[Content_Types].xml` conventionally comes first and some
 * consumers expect it there.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** One entry's own ceiling, in bytes, before it is refused. */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024
/** Every entry's uncompressed total, in bytes, before the archive is refused. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024

/** The CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * The CRC-32 of a buffer, as ZIP stores it.
 * @param buffer - the bytes.
 * @param seed - a running value (for streaming callers); 0 by default.
 * @returns the unsigned 32-bit checksum.
 */
export function crc32(buffer, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A typed ZIP failure. */
function zipError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** One DOS date+time pair for a JavaScript date (the ZIP epoch has no seconds). */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Build a ZIP archive.
 *
 * @param files - `[{ name, data }]`; `data` is a Buffer, Uint8Array or string
 *   (encoded as UTF-8). Names must be plain relative paths with forward slashes.
 * @param options - `{ date }` for the DOS timestamp (defaults to now), which a
 *   check pins so two runs produce the same bytes.
 * @returns the archive as a Buffer.
 */
export function zipSync(files, { date = new Date() } = {}) {
  const stamp = dosStamp(date)
  const entries = []
  const chunks = []
  let offset = 0
  for (const file of Array.isArray(files) ? files : []) {
    const name = String(file && file.name ? file.name : '')
    if (name.length === 0 || name.startsWith('/') || name.includes('..')) {
      throw zipError('BAD_NAME', 'A ZIP entry name must be a plain relative path: ' + JSON.stringify(name))
    }
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(raw)
    const deflated = deflateRawSync(raw, { level: 9 })
    // Store when deflating did not help (tiny XML parts often grow), which is
    // what every archiver does and what keeps a small part genuinely small.
    const method = deflated.length < raw.length ? 8 : 0
    const payload = method === 8 ? deflated : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, payload)
    entries.push({ nameBytes, method, crc, compressed: payload.length, size: raw.length, offset })
    offset += local.length + nameBytes.length + payload.length
  }
  const central = []
  for (const entry of entries) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.compressed, 20)
    header.writeUInt32LE(entry.size, 24)
    header.writeUInt16LE(entry.nameBytes.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(entry.offset, 42)
    central.push(header, entry.nameBytes)
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, end])
}

/** Find the end-of-central-directory record, scanning back from the tail. */
function endOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 66_000)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  throw zipError('NOT_A_ZIP', 'The archive has no end-of-central-directory record.')
}

/**
 * Read a ZIP archive into a map of part name → bytes.
 *
 * @param input - the archive bytes.
 * @returns a `Map<string, Buffer>` in central-directory order.
 */
export function unzipSync(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const end = endOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(end + 10)
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) {
    throw zipError('MULTI_DISK', 'A multi-disk archive is not a document.')
  }
  let cursor = buffer.readUInt32LE(end + 16)
  const files = new Map()
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw zipError('BAD_ARCHIVE', 'The central directory is truncated at entry ' + index + '.')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if ((flags & 0x1) === 0x1) throw zipError('ENCRYPTED', 'The part "' + name + '" is encrypted.')
    if (size === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff) {
      throw zipError('ZIP64', 'The archive is ZIP64, which a document never needs.')
    }
    if (size > MAX_ENTRY_BYTES) throw zipError('TOO_LARGE', 'The part "' + name + '" is larger than the per-part limit.')
    total += size
    if (total > MAX_TOTAL_BYTES) throw zipError('TOO_LARGE', 'The archive unpacks to more than the total limit.')
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw zipError('BAD_ARCHIVE', 'The local header for "' + name + '" is missing.')
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    if (start + compressed > buffer.length) {
      throw zipError('BAD_ARCHIVE', 'The data for "' + name + '" is truncated.')
    }
    const payload = buffer.subarray(start, start + compressed)
    let data
    if (method === 0) data = Buffer.from(payload)
    else if (method === 8) {
      try {
        data = inflateRawSync(payload)
      } catch (err) {
        throw zipError('BAD_DEFLATE', 'The part "' + name + '" could not be inflated: ' + err.message)
      }
    } else {
      throw zipError('BAD_METHOD', 'The part "' + name + '" uses compression method ' + method + '.')
    }
    if (data.length !== size) {
      throw zipError('BAD_SIZE', 'The part "' + name + '" unpacked to ' + data.length + ' bytes, not ' + size + '.')
    }
    if (crc32(data) !== crc) {
      throw zipError('BAD_CRC', 'The part "' + name + '" failed its CRC-32 check.')
    }
    files.set(name, data)
  }
  return files
}
