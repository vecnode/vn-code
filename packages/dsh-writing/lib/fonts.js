/**
 * dsh-writing — the font families this machine actually has.
 *
 * A word processor's font picker should offer the families a person has
 * installed rather than a hardcoded list. Collecting them normally means
 * shelling out (`fc-list`, `system_profiler`, a registry walk), and this
 * package ships **zero npm dependencies** and starts no process of its own (the
 * pack's rules), so the enumeration here is done the only way that is portable
 * and silent: scan the directories each platform keeps fonts in, and read each
 * font's `name` table.
 *
 * One fact shapes the whole module: **font files are large and their identity
 * is in the first few kilobytes.** A 40 MiB CJK or emoji font answers "who are
 * you" from its 12-byte sfnt header, its table directory and its `name` table,
 * so nothing here ever loads a font whole. `listFonts` reads those three windows
 * through `fs.readSync` and stops; the parse is one code path over a
 * random-access reader, so a caller who already holds the bytes (`readFontName`)
 * and a caller reading a 40 MiB file in pieces run exactly the same logic.
 *
 * Deliberately not supported, each with the reason:
 *
 *   - **WOFF and WOFF2** are compressed containers, not sfnt files. A browser
 *     hands the installed family names to the page anyway, and a second
 *     decompressor here would buy the picker nothing.
 *   - **A font with no `name` table, or no readable family string.** A family
 *     this cannot name is a family the picker cannot offer, so the file is
 *     skipped rather than guessed at from its file name.
 *   - **Variable-font named instances** (`fvar`): the family a person picks is
 *     the family name, which is what a variable font's `name` table already
 *     carries.
 *
 * Every offset is checked against the real byte length BEFORE it is read: a
 * truncated download or a hostile file dropped in `~/.fonts` must leave the
 * listing intact, so `readFontName` answers `null` and `listFonts` counts a
 * `failed` file instead of throwing.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'

/** The font file extensions this module reads. */
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.otc']

/** The sfnt version tags a readable TrueType/OpenType font may open with. */
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74797031])
/** 'ttcf' — the first tag of a TrueType Collection. */
const TTC_TAG = 0x74746366
/** 'name' — the table holding the family and style strings. */
const NAME_TAG = 0x6e616d65
/** 'OS/2' — the table holding `usWeightClass` and `fsSelection`. */
const OS2_TAG = 0x4f532f32
/** 'head' — the table holding `macStyle`. */
const HEAD_TAG = 0x68656164
/** Windows LANGID for US English, the record a family name is preferred from. */
const WINDOWS_ENGLISH = 0x0409
/** How deep a font directory tree is walked without an explicit `maxDepth`. */
const DEFAULT_MAX_DEPTH = 3
/** How many font files are considered without an explicit `maxFiles`. */
const DEFAULT_MAX_FILES = 4000
/** How large a font file may be without an explicit `maxFileBytes`. */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
/**
 * The largest window ever read out of one font, in bytes.
 *
 * The format's own 16-bit fields bound every window this asks for: a table
 * directory is at most 65 535 tables x 16 bytes, and a `name` string is reached
 * through a 16-bit string offset plus a 16-bit record offset plus a 16-bit
 * length, so no name can live past ~960 KiB of the table. Capping here therefore
 * loses no readable name while keeping a hostile directory entry from asking for
 * a whole file in one allocation.
 */
const MAX_WINDOW_BYTES = 1024 * 1024
/** The order styles are reported in, weakest first. */
const STYLE_ORDER = ['regular', 'bold', 'italic', 'boldItalic']

/**
 * The directories one platform keeps fonts in, most specific first.
 *
 * The order is the precedence a person's own fonts deserve over the system's: a
 * family installed in `~/Library/Fonts` or `%LOCALAPPDATA%` must be the one
 * named, and the system directory is only a fallback. Nothing is stat'ed here,
 * because a caller may want only the list and a missing directory is normal on a
 * minimal container; `listFonts` keeps the ones that exist.
 *
 * @param options - `{ env, platform, home }`, each defaulting to the live
 *   process (`process.env`, `process.platform`, `os.homedir()`). A check names
 *   a platform it is not running on rather than mocking the module.
 * @returns an array of absolute directory paths, which may not exist, ending
 *   with every directory named in `DSH_WRITING_FONT_DIRS`.
 */
export function fontDirectories(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : homedir()
  const dirs = []
  if (platform === 'win32') {
    // WINDIR is the only Windows directory that may be relocated; when the
    // variable is absent (a stripped-down service environment) the documented
    // default is what Windows actually uses.
    dirs.push(join(env.WINDIR || 'C:\\Windows', 'Fonts'))
    dirs.push(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'))
    dirs.push(join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
  } else if (platform === 'darwin') {
    dirs.push(
      join(home, 'Library', 'Fonts'),
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Network/Library/Fonts',
    )
  } else {
    // The XDG locations first, then the two legacy ones a distribution or a
    // font package still writes to, then the X11 tree.
    dirs.push(
      join(home, '.local', 'share', 'fonts'),
      join(home, '.fonts'),
      '/usr/local/share/fonts',
      '/usr/share/fonts',
      '/usr/share/X11/fonts',
    )
  }
  // Last, so it can point the module at a directory that is not a font
  // directory at all: the hook a check feeds a synthetic font through and a
  // person uses to examine one folder.
  const extra = typeof env.DSH_WRITING_FONT_DIRS === 'string' ? env.DSH_WRITING_FONT_DIRS : ''
  for (const dir of extra.split(delimiter)) {
    if (dir.length > 0) dirs.push(dir)
  }
  // Deduplicate on the path as given — no resolve or normalize — so a caller
  // gets back exactly the spellings it passed and two platforms' identical
  // entries collapse to the higher-precedence one.
  const seen = new Set()
  const out = []
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/**
 * The family and style names inside one font file's `name` table.
 *
 * @param bytes - the file's bytes (or a Buffer of at least the sfnt header and
 *   the `name` table).
 * @returns `{ family, subfamily, fullName, bold, italic, weight }`, or `null`
 *   when the bytes are not a readable TrueType/OpenType font.
 */
export function readFontName(bytes) {
  const view = asBytes(bytes)
  if (view === null) return null
  try {
    return readFontIdentity((offset, length) => {
      if (length <= 0 || offset + length > view.length) return null
      return view.subarray(offset, offset + length)
    })
  } catch (err) {
    // A table directory can still describe something this code did not
    // anticipate; a font that cannot be read is a font that is not offered.
    return null
  }
}

/**
 * Every font family on this machine, deduplicated.
 *
 * @param options - `{ dirs, maxFiles, maxDepth, maxFileBytes }`; `dirs` defaults
 *   to `fontDirectories()`, the limits to 4000 files, 3 levels and 64 MiB.
 * @returns `{ families, scanned, parsed, failed, skipped, dirs, truncated }`:
 *   `families` is `[{ family, styles, files }]` sorted by family name, `scanned`
 *   counts the font-extension files considered, `parsed` the ones whose `name`
 *   table was read, `failed` the ones that could not be read, `skipped` the ones
 *   refused for size, `dirs` the directories that existed and were walked, and
 *   `truncated` whether `maxFiles` stopped the walk early.
 */
export function listFonts(options = {}) {
  const maxDepth = limitOf(options.maxDepth, DEFAULT_MAX_DEPTH)
  const maxFiles = limitOf(options.maxFiles, DEFAULT_MAX_FILES)
  const maxFileBytes = limitOf(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES)
  const candidates = Array.isArray(options.dirs) ? options.dirs.map(String) : fontDirectories()
  const extensions = new Set(FONT_EXTENSIONS.map((extension) => extension.toLowerCase()))
  const byFamily = new Map()
  const walked = []
  let scanned = 0
  let parsed = 0
  let failed = 0
  let skipped = 0
  let truncated = false
  let stop = false
  const walk = (directory, depth) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (err) {
      // A font directory that is missing or unreadable is simply not a source
      // of fonts; that is not an error the caller has to handle.
      return
    }
    for (const entry of entries) {
      if (stop) return
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() && entry.isSymbolicLink()) {
        // A linked directory of fonts is followed, because a distribution or a
        // person legitimately arranges fonts that way. Recursion is bounded by
        // the depth limit, so a link cycle cannot spin.
        const linked = statOf(full)
        if (linked !== null && linked.isDirectory()) {
          if (depth < maxDepth) walk(full, depth + 1)
          continue
        }
      }
      if (!extensions.has(extname(entry.name).toLowerCase())) continue
      // The file limit counts candidates only: a directory full of documents is
      // not the walk's budget, a directory full of fonts is.
      if (scanned >= maxFiles) {
        truncated = true
        stop = true
        return
      }
      scanned += 1
      const info = statOf(full)
      if (info === null || !info.isFile()) {
        failed += 1
        continue
      }
      if (info.size > maxFileBytes) {
        skipped += 1
        continue
      }
      const font = readFontFile(full, info.size)
      if (font === null) {
        failed += 1
        continue
      }
      parsed += 1
      const key = font.family.toLowerCase()
      let family = byFamily.get(key)
      if (family === undefined) {
        // The first spelling seen is the one reported, so a family installed
        // twice with different capitalisation is offered once, as written by
        // whichever font the walk met first.
        family = { family: font.family, styles: new Set(), files: 0 }
        byFamily.set(key, family)
      }
      family.styles.add(styleOf(font))
      family.files += 1
    }
  }
  for (const directory of candidates) {
    if (stop) break
    const info = statOf(directory)
    if (info === null || !info.isDirectory()) continue
    walked.push(directory)
    walk(directory, 0)
  }
  const families = [...byFamily.values()]
    .map((family) => ({
      family: family.family,
      styles: STYLE_ORDER.filter((style) => family.styles.has(style)),
      files: family.files,
    }))
    .sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: 'base', numeric: false }))
  return { families, scanned, parsed, failed, skipped, dirs: walked, truncated }
}

/** A byte view of whatever a caller passed, or null when it is not bytes. */
function asBytes(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return null
}

/** One numeric option, or its default when the caller gave something unusable. */
function limitOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** One path's stat, or null when it does not exist or cannot be examined. */
function statOf(target) {
  try {
    return statSync(target)
  } catch (err) {
    return null
  }
}

/** The style name one font's flags make it, weakest first. */
function styleOf(font) {
  if (font.bold && font.italic) return 'boldItalic'
  if (font.bold) return 'bold'
  if (font.italic) return 'italic'
  return 'regular'
}

/** One UTF-16BE string out of `[start, end)`; a trailing odd byte is dropped. */
function utf16be(view, start, end) {
  let out = ''
  for (let at = start; at + 1 < end; at += 2) out += String.fromCharCode((view[at] << 8) | view[at + 1])
  return out
}

/**
 * The text of one `name` record, or null when the record points outside the
 * table.
 *
 * platformID 3 (Windows) and 0 (Unicode) store UTF-16BE. platformID 1 (Mac)
 * stores the bytes as they are, which latin1 reads back unchanged, and an
 * unrecognised platform is treated the same way because latin1 is the one
 * encoding that never fails on arbitrary bytes.
 */
function decodeNameRecord(view, stringOffset, record) {
  const start = stringOffset + record.offset
  const end = start + record.length
  if (record.length === 0 || end > view.length) return null
  const text = record.platform === 3 || record.platform === 0 ? utf16be(view, start, end) : view.toString('latin1', start, end)
  // Some fonts pad a name with NULs; a family of "\u0000" is not a family.
  return text.replaceAll('\u0000', '').trim()
}

/**
 * How good one `name` record is, lower being better: a Windows/Unicode English
 * record first, then any Windows/Unicode record, then an English record in
 * another encoding, then whatever is left.
 */
function nameRank(record) {
  const unicode = record.platform === 3 || record.platform === 0
  if (unicode && record.language === WINDOWS_ENGLISH) return 0
  if (unicode) return 1
  if (record.language === WINDOWS_ENGLISH) return 2
  return 3
}

/**
 * The family and style names out of the `name` table's own bytes.
 *
 * @param view - the `name` table's bytes, starting at the table.
 * @returns `{ family, subfamily, fullName }`, all strings, or null when the
 *   table is unusable or carries no family.
 */
function readNameTable(view) {
  if (view.length < 6) return null
  const format = view.readUInt16BE(0)
  // Format 1 appends a language-tag array after the records; the records this
  // reads are laid out identically, so the format only has to be one of them.
  if (format !== 0 && format !== 1) return null
  const count = view.readUInt16BE(2)
  const stringOffset = view.readUInt16BE(4)
  if (count === 0 || 6 + count * 12 > view.length) return null
  const records = []
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 12
    records.push({
      platform: view.readUInt16BE(at),
      language: view.readUInt16BE(at + 4),
      nameID: view.readUInt16BE(at + 6),
      length: view.readUInt16BE(at + 8),
      offset: view.readUInt16BE(at + 10),
    })
  }
  // The first of these name IDs that carries text wins: 16 is the typographic
  // family a font declares for itself, and 1 is the legacy family it falls back
  // to when it declares none.
  const pick = (nameIDs) => {
    for (const nameID of nameIDs) {
      let best = ''
      let rank = Infinity
      for (const record of records) {
        if (record.nameID !== nameID) continue
        const recordRank = nameRank(record)
        if (recordRank >= rank) continue
        const text = decodeNameRecord(view, stringOffset, record)
        if (text === null || text.length === 0) continue
        best = text
        rank = recordRank
      }
      if (best.length > 0) return best
    }
    return ''
  }
  const family = pick([16, 1])
  // No nameable family means no family the picker can offer; the file is a
  // failed candidate, not an entry invented from its path.
  if (family.length === 0) return null
  return { family, subfamily: pick([17, 2]), fullName: pick([4]) }
}

/**
 * The identity of one font, through a random-access reader.
 *
 * @param read - `(offset, length) => bytes | null`, returning exactly `length`
 *   bytes or null when that range is not there. The null is what makes a
 *   truncated file fail softly instead of throwing.
 * @returns the five identity fields, or null when this is not a readable font.
 */
function readFontIdentity(read) {
  let header = read(0, 12)
  if (header === null) return null
  let base = 0
  // A collection ('ttcf') is a version, a count and an array of offsets to whole
  // fonts; its font 0 is the first face of the family, and reading that keeps a
  // .ttc useful instead of unreadable.
  if (header.readUInt32BE(0) === TTC_TAG) {
    const offsets = read(12, 4)
    if (offsets === null) return null
    base = offsets.readUInt32BE(0)
    header = read(base, 12)
    if (header === null) return null
  }
  if (!SFNT_VERSIONS.has(header.readUInt32BE(0))) return null
  const numTables = header.readUInt16BE(4)
  if (numTables === 0) return null
  // The table directory starts right after the 12-byte sfnt header; a directory
  // larger than the file means the file was cut short.
  const directory = read(base + 12, numTables * 16)
  if (directory === null) return null
  let nameTable = null
  let os2Table = null
  let headTable = null
  for (let index = 0; index < numTables; index += 1) {
    const at = index * 16
    const tag = directory.readUInt32BE(at)
    const offset = directory.readUInt32BE(at + 8)
    const length = directory.readUInt32BE(at + 12)
    if (tag === NAME_TAG) nameTable = { offset, length }
    else if (tag === OS2_TAG) os2Table = { offset, length }
    else if (tag === HEAD_TAG) headTable = { offset, length }
  }
  if (nameTable === null || nameTable.length === 0) return null
  const nameBytes = read(nameTable.offset, Math.min(nameTable.length, MAX_WINDOW_BYTES))
  if (nameBytes === null) return null
  const names = readNameTable(nameBytes)
  if (names === null) return null
  // The two fields the style needs are `usWeightClass` at OS/2 offset 4 and
  // `fsSelection` at offset 62, so one 64-byte window serves both; a shorter
  // OS/2 table is simply one whose style bits are not declared.
  const os2Bytes = os2Table === null || os2Table.length === 0 ? null : read(os2Table.offset, Math.min(os2Table.length, 64))
  // `macStyle` is the uint16 at head offset 44 — two bytes, the whole field.
  const headBytes = headTable === null || headTable.length < 46 ? null : read(headTable.offset + 44, 2)
  let bold = null
  let italic = null
  let weight = null
  if (os2Bytes !== null && os2Bytes.length >= 64) {
    // fsSelection bit 5 is BOLD and bit 0 is ITALIC; these are the flags the
    // font itself sets, so they outrank every other signal.
    const fsSelection = os2Bytes.readUInt16BE(62)
    bold = (fsSelection & 0x20) !== 0
    italic = (fsSelection & 0x1) !== 0
  }
  if (os2Bytes !== null && os2Bytes.length >= 6) {
    const declared = os2Bytes.readUInt16BE(4)
    // 0 means the font declares no weight, which is not a weight of zero.
    if (declared > 0) weight = declared
  }
  if (bold === null && headBytes !== null) {
    // macStyle bit 0 is BOLD and bit 1 is ITALIC, the pre-OS/2 way to say it.
    const macStyle = headBytes.readUInt16BE(0)
    bold = (macStyle & 0x1) !== 0
    italic = (macStyle & 0x2) !== 0
  }
  // Only when neither table said anything does the style word in the name
  // decide, because a name like "Demi" is a marketing word, not a flag.
  if (bold === null) bold = /bold/i.test(names.subfamily)
  if (italic === null) italic = /italic|oblique/i.test(names.subfamily)
  if (weight === null) weight = bold ? 700 : 400
  return {
    family: names.family,
    subfamily: names.subfamily,
    fullName: names.fullName.length > 0 ? names.fullName : names.subfamily.length > 0 ? names.family + ' ' + names.subfamily : names.family,
    bold,
    italic,
    weight,
  }
}

/**
 * A reader over one open file that fetches only the windows the parse asks for.
 *
 * @param handle - an open file descriptor.
 * @param size - the file's byte length, from its stat.
 * @returns the `read` function `readFontIdentity` expects.
 */
function fileReader(handle, size) {
  return (offset, length) => {
    if (length <= 0 || length > MAX_WINDOW_BYTES) return null
    if (offset + length > size) return null
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    // A short read is not the end of the data until it returns 0: a file on a
    // network share legitimately answers in pieces.
    while (filled < length) {
      const got = readSync(handle, buffer, filled, length - filled, offset + filled)
      if (got <= 0) return null
      filled += got
    }
    return buffer
  }
}

/**
 * One candidate file's identity, or null when it cannot be read.
 *
 * @param filePath - the file to open.
 * @param size - its byte length, from its stat.
 * @returns what `readFontIdentity` returned, or null.
 */
function readFontFile(filePath, size) {
  let handle
  try {
    handle = openSync(filePath, 'r')
  } catch (err) {
    return null
  }
  try {
    return readFontIdentity(fileReader(handle, size))
  } catch (err) {
    return null
  } finally {
    try {
      closeSync(handle)
    } catch (err) {
      // The descriptor is released either way; a close that fails is not a
      // reason to lose the font that was already read.
    }
  }
}
