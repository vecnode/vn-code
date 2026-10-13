/**
 * dsh-research — the bibliographic import/export engine.
 *
 * ONE record shape is the whole contract of this module: every importer produces
 * it, every renderer consumes it, and nothing here knows about a run, a style or
 * a document. That is what lets a `.ris` a person exported from a reference
 * manager in 2011 and a `.bib` an agent wrote five minutes ago meet in the same
 * place — and it is why the styles modules downstream have exactly one shape to
 * learn instead of four.
 *
 *   { key, kind, title, authors: [{ family, given }], year, container,
 *     editor: [{ family, given }], volume, issue, pages, edition, publisher,
 *     place, doi, url, isbn, issn, accessed, note }
 *
 * Four rules hold everywhere in this file. Each one exists because breaking it
 * fails silently, and a silent bibliography failure is discovered by a reader
 * rather than by a test:
 *
 *   1. **No field is ever invented.** An absent value is `''`, and an absent name
 *      list is `[]` — never `undefined`, never the string `'undefined'`. A record
 *      goes on to be printed, and "undefined" under a title is a defect nobody
 *      notices until the paper is out.
 *   2. **Only text, only built-ins.** No dependency, no clock, no filesystem, no
 *      network: a citation file is data and this module is a pure function of it,
 *      so the same bytes always produce the same records. That is also what lets
 *      the check drive every branch with a string literal.
 *   3. **A record nothing can cite is dropped, and the drop is reported.** A
 *      record with neither a title nor a container cannot be referenced from a
 *      sentence, so it is skipped and counted — see `importCitationsReport`. No
 *      other imperfect record is ever discarded: a missing year is `''`, not a
 *      reason to lose the citation.
 *   4. **A key is legal or it is not a key.** `[a-z0-9-]`, collapsed, trimmed,
 *      at most 40 characters from `suggestKey`, because the key is what a
 *      document's `[[cite:...]]` markers and a run's ledger both address.
 *
 * The formats, and what each one cannot carry (a renderer is honest about the
 * loss rather than inventing a field to hide it):
 *
 *   - **RIS** — line based, `TY  - JOUR` … `ER  - `. Carries every field of the
 *     shape except a record's identity, which it carries in `ID`. It has no tag
 *     for a preprint or a standard, so those render to RIS's own `UNPB`/`STD`
 *     tags and read back as `report`/`journal-article` — see `RIS_KIND`.
 *   - **BibTeX** — brace matched, not line based. Cannot carry a dataset's or a
 *     standard's kind (its entry vocabulary here has no entry for either), and a
 *     title's markup braces are TEXT to this module, so `{NASA}` reads back as
 *     `NASA`.
 *   - **PubMed/MEDLINE (`nbib`)** — tagged and hard wrapped. Indexes journal
 *     articles, so every record it yields is a `journal-article`.
 *   - **EndNote tagged (`enw`)** — `%TAG value` lines. Carries no access date.
 *
 * The `importX`/`renderX` pair for each of RIS, BibTeX and EndNote is a ROUND
 * TRIP for every field the format can carry, and the check asserts it record by
 * record rather than promising it here.
 */

import { ResearchError } from './run.js'

/** The closed kind vocabulary. A kind outside this list is not a kind. */
export const KINDS = Object.freeze([
  'journal-article',
  'book',
  'chapter',
  'report',
  'web',
  'thesis',
  'preprint',
  'dataset',
  'standard',
  'conference-paper',
])

/**
 * Every scalar field, in the order the shape declares them.
 *
 * The order is part of the contract, not cosmetics: `Object.keys` on a record is
 * how a caller (and the check) proves that nothing was added and nothing fell
 * out, and insertion order is the only thing that makes that comparison stable
 * across a JSON round trip.
 */
export const RECORD_FIELDS = Object.freeze([
  'key',
  'kind',
  'title',
  'year',
  'container',
  'volume',
  'issue',
  'pages',
  'edition',
  'publisher',
  'place',
  'doi',
  'url',
  'isbn',
  'issn',
  'accessed',
  'note',
])

/** The two name lists, which are `[]` rather than `''` when they are empty. */
const NAME_FIELDS = Object.freeze(['authors', 'editor'])

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------
/** A trimmed string, whatever arrived. `null` is `''`, not `'null'`. */
function text(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/** Runs of whitespace collapsed to one space. A wrapped field is one value. */
function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lines, whichever ending wrote them: a `.ris` from Windows and one from a Mac
 *  are the same file, and a parser that assumed one ending would silently return
 *  no records at all for the other. */
function splitLines(value) {
  return String(value ?? '').split(/\r\n|\r|\n/)
}

/** A year whenever four consecutive digits exist (`2024/03/01`, `2024 Mar 3`,
 *  `c2024`). Where they do not, the value is kept as written: a record whose year
 *  says `in press` is more useful than one whose year says nothing. */
function yearOf(value) {
  const source = collapse(value)
  const match = /\d{4}/.exec(source)
  return match === null ? source : match[0]
}

/** Page ranges are written with `--`, an en dash, or one hyphen; a record holds
 *  one form so that two records with the same range compare equal. */
function normalisePages(value) {
  return collapse(value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/-{2,}/g, '-')
}

/** `45-67` -> `{ start: '45', end: '67' }`; `45` -> `{ start: '45', end: '' }`. */
function splitPages(value) {
  const source = normalisePages(value)
  const match = /^(.+?)\s*-\s*(.+)$/.exec(source)
  if (match === null) return { start: source, end: '' }
  return { start: match[1].trim(), end: match[2].trim() }
}

/** The inverse, so start/end tags in one format survive a round trip. */
function joinPages(start, end) {
  const from = normalisePages(start)
  const to = normalisePages(end)
  if (from === '') return to
  if (to === '') return from
  return from + '-' + to
}

/** A DOI is an identifier, never a URL: `https://doi.org/10.x` and `doi:10.x`
 *  are the same DOI as `10.x`, and a record that stores three spellings of one
 *  identifier is a record a deduplicator cannot work with. */
function doiOf(value) {
  return text(value)
    .replace(/^\s*(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
}

/** ISSN is four digits, a hyphen, three digits and a check character. Used to
 *  tell the two serial identifiers apart where a format has ONE tag for both. */
function looksLikeIssn(value) {
  return /^\d{4}-\d{3}[\dxX]$/.test(collapse(value))
}

/** ISBN is ten or thirteen digits once its hyphens are gone. */
function looksLikeIsbn(value) {
  const digits = collapse(value).replace(/[-\s]/g, '')
  return /^(?:\d{9}[\dxX]|\d{13})$/.test(digits)
}

/** Place a serial number in the right field: `SN` and `%@` each mean ISBN in one
 *  entry and ISSN in the next, and only the number's own shape says which. */
function assignSerial(record, value) {
  const serial = collapse(value)
  if (serial === '') return
  if (looksLikeIssn(serial) && record.issn === '') {
    record.issn = serial
    return
  }
  if (looksLikeIsbn(serial) && record.isbn === '') {
    record.isbn = serial
    return
  }
  // Neither shape is recognisable, so the entry's KIND is the only evidence left.
  const journalish = record.kind === 'journal-article' || record.kind === 'preprint' || record.kind === 'conference-paper'
  if (journalish && record.issn === '') record.issn = serial
  else if (record.isbn === '') record.isbn = serial
  else if (record.issn === '') record.issn = serial
}

/** Two free-text notes, joined rather than one of them being lost. MEDLINE's
 *  abstract and EndNote's two note tags both land in the record's single
 *  free-text slot; the alternative, keeping the first and dropping the second,
 *  throws away something a person wrote. */
function mergeNote(first, second) {
  const a = collapse(first)
  const b = collapse(second)
  if (a === '') return b
  if (b === '') return a
  return a + '\n\n' + b
}

// ---------------------------------------------------------------------------
// The record itself
// ---------------------------------------------------------------------------
/** A record with every field present and empty. */
export function blankRecord() {
  return {
    key: '',
    kind: '',
    title: '',
    authors: [],
    year: '',
    container: '',
    editor: [],
    volume: '',
    issue: '',
    pages: '',
    edition: '',
    publisher: '',
    place: '',
    doi: '',
    url: '',
    isbn: '',
    issn: '',
    accessed: '',
    note: '',
  }
}

/**
 * The one place a partly-filled object becomes a record.
 *
 * Every importer, and every caller handing in a hand-built object, comes through
 * here — so "a field is never `undefined`" is enforced once instead of being
 * remembered in twenty places, and a JSON round trip of a record is lossless.
 */
export function normaliseRecord(raw) {
  const record = blankRecord()
  if (raw === null || typeof raw !== 'object') return record
  for (const field of RECORD_FIELDS) record[field] = text(raw[field])
  for (const field of NAME_FIELDS) record[field] = normaliseNames(raw[field])
  record.doi = doiOf(record.doi)
  return record
}

/** A name list, however the caller wrote it. */
function normaliseNames(value) {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return parseAuthors(value)
  if (!Array.isArray(value)) return []
  const names = []
  for (const entry of value) {
    // A plain string inside the list is what a hurried caller writes, and
    // silently dropping the attribution is the wrong way to teach them.
    if (typeof entry === 'string') {
      names.push(...parseAuthors(entry))
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const family = text(entry.family)
    const given = text(entry.given)
    if (family === '' && given === '') continue
    names.push({ family, given })
  }
  return names
}

/**
 * Build a record from an importer's field bag, or drop it.
 *
 * The drop rule is the ONLY rejection in this module and it is deliberately
 * narrow: a record with no title and no container cannot be cited by any marker
 * a document could hold, while every other flaw (no year, no author, no pages)
 * is an incompleteness a citation survives.
 */
function makeRecord(fields, dropped) {
  const record = normaliseRecord(fields)
  // Every imported record gets a key, whether or not its format had a place to
  // carry one: the key is what a document marker addresses, and a record without
  // one is a citation that cannot be referred to at all. A format that does carry
  // a key (RIS's `ID`, BibTeX's entry key, EndNote's `%F`) has already supplied
  // it, and `suggestKey` only fills the gap.
  if (record.key === '') record.key = suggestKey(record)
  if (record.title === '' && record.container === '') {
    if (Array.isArray(dropped)) {
      dropped.push({
        key: record.key,
        reason: 'no title and no container: nothing a document could cite',
      })
    }
    return null
  }
  return record
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
/**
 * Any string as a legal citation key.
 *
 * Accents are folded (`Müller` and `Muller` are one key, so a key cannot depend
 * on how a keyboard was configured), everything outside `[a-z0-9-]` becomes a
 * single dash, and the dashes are trimmed — a key with a leading or trailing
 * dash is a key that looks like a typo in a document marker.
 */
export function keyFrom(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The words that carry no information in a key. A key is an ADDRESS, not a
 * summary, and `the`/`of`/`in` would spend its 40 characters on nothing.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'before', 'between', 'both', 'but', 'by', 'can', 'did', 'do',
  'does', 'during', 'each', 'for', 'from', 'had', 'has', 'have', 'how', 'in',
  'into', 'is', 'it', 'its', 'more', 'most', 'no', 'not', 'of', 'on', 'or',
  'other', 'our', 'out', 'over', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'under', 'up', 'was', 'we', 'were', 'what', 'when', 'which', 'while', 'who',
  'why', 'will', 'with', 'would', 'you', 'your',
])

/** The title's significant words: two letters or more, not a stopword, and not a
 *  bare number — the key already carries the year. */
function titleWords(title) {
  const words = []
  for (const token of String(title ?? '').split(/[^\p{L}\p{N}]+/u)) {
    if (token === '') continue
    const lower = token.toLowerCase()
    if (lower.length < 2) continue
    if (/^\d+$/.test(lower)) continue
    if (STOPWORDS.has(lower)) continue
    words.push(lower)
  }
  return words
}

/**
 * A legal, stable key for a record: first author's family, the year, then up to
 * three significant title words, with no separators — `Smith` + `2024` +
 * `The effect of X on Y` is `smith2024effect`, which is the shape every reference
 * manager already uses and therefore the shape a person can guess.
 *
 * Stability is the point: the same record must always produce the same key, so
 * that a marker written last week still resolves today.
 */
export function suggestKey(record) {
  const one = normaliseRecord(record)
  const family = one.authors.length > 0 ? keyFrom(one.authors[0].family) : ''
  const year = keyFrom((/\d{4}/.exec(one.year) ?? [''])[0])
  const words = titleWords(one.title).slice(0, 3).map(keyFrom).filter((word) => word !== '')
  let key = keyFrom(family + year + words.join(''))
  if (key.length > 40) key = key.slice(0, 40).replace(/-+$/g, '')
  // Nothing at all to name the record after. A placeholder is still a key, and a
  // caller can always overwrite it; an empty string is not a legal key at all.
  return key === '' ? 'untitled' : key
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
/** `J`, `J.`, `AB`, `A.B.` — but not `Jan`, which is somebody's name. */
const INITIALS = /^(?:[A-Z]\.?\s*)+$/

function looksLikeInitials(token) {
  return token.length > 0 && token.length <= 4 && INITIALS.test(token)
}

/** A brace group wrapping the whole value, removed. BibTeX protects a name's
 *  capitalization with braces, and the braces are markup, not the name. */
function stripOuterBraces(value) {
  let source = value.trim()
  while (source.length >= 2 && source.startsWith('{') && matchingBrace(source, 0) === source.length - 1) {
    source = source.slice(1, -1).trim()
  }
  return source
}

/**
 * One name.
 *
 * The COMMA is the only unambiguous separator and every format that has one uses
 * it: `Smith, J.` is family then given, and `van der Berg, Jan` is one family of
 * three words. With no comma the two conventions collide — MEDLINE writes
 * `Smith J` (family first) and BibTeX writes `J. Smith` (family last) — so the
 * trailing initials are what decides: `Smith J` ends in initials and is read
 * family first, and a name ending in a word is read in BibTeX's order. A name
 * that is ambiguous even then (`Smith John`) is read family last, and the
 * formats this module reads all give a comma when they mean the other.
 */
function parseOneName(value) {
  const source = stripOuterBraces(value)
  if (source === '') return null
  const comma = source.indexOf(',')
  if (comma !== -1) {
    const family = source.slice(0, comma).trim()
    const given = source.slice(comma + 1).trim()
    if (family === '' && given === '') return null
    // A comma with nothing after it is how a corporate author is written:
    // `World Health Organization,` is one family and no given name.
    return { family, given }
  }
  const tokens = source.split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) return null
  if (tokens.length === 1) return { family: tokens[0], given: '' }
  const last = tokens[tokens.length - 1]
  if (looksLikeInitials(last)) return { family: tokens.slice(0, -1).join(' '), given: last }
  return { family: last, given: tokens.slice(0, -1).join(' ') }
}

/** A `Family Initials` pair — the shape of one author in the comma-separated
 *  list `Smith J, Jones AB`, which is how MEDLINE exports a whole author list. */
function looksLikeFamilyGiven(part) {
  const tokens = part.trim().split(/\s+/).filter((token) => token !== '')
  return tokens.length >= 2 && looksLikeInitials(tokens[tokens.length - 1])
}

/** Split on the literal ` and ` at brace depth 0, which is how BibTeX separates
 *  names. A name inside braces (`{Smith, J. and Sons}`) is one name, so the
 *  depth matters: a plain string split would invent an author. */
function splitOnAnd(value) {
  const parts = []
  let depth = 0
  let quote = false
  let start = 0
  let index = 0
  while (index < value.length) {
    const ch = value[index]
    if (ch === '\\') {
      index += 2
      continue
    }
    if (quote) {
      if (ch === '"') quote = false
      index += 1
      continue
    }
    if (ch === '{') {
      depth += 1
      index += 1
      continue
    }
    if (ch === '}') {
      if (depth > 0) depth -= 1
      index += 1
      continue
    }
    if (ch === '"' && depth === 0) {
      quote = true
      index += 1
      continue
    }
    if (depth === 0 && /\s/.test(ch)) {
      const match = /^\s+and\s+/i.exec(value.slice(index))
      if (match !== null) {
        parts.push(value.slice(start, index))
        index += match[0].length
        start = index
        continue
      }
    }
    index += 1
  }
  parts.push(value.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * An author list in any of the three shapes the formats use:
 * `Smith, J.; Jones, Alice B.`, `Smith J, Jones AB`, or BibTeX's ` and ` form.
 *
 * The semicolon is always a list separator, ` and ` is always a list separator at
 * brace depth 0, and a comma is a separator only when BOTH sides of it are
 * `Family Initials` pairs — because `Smith, J.` is one author and `Smith J, Jones
 * AB` is two, and only the shape tells them apart.
 */
export function parseAuthors(value) {
  const source = collapse(value)
  if (source === '') return []
  const semis = source.split(';').map((part) => part.trim()).filter((part) => part !== '')
  if (source.includes(';')) {
    const names = semis.map(parseOneName).filter((name) => name !== null)
    return names.length > 0 ? names : []
  }
  const andParts = splitOnAnd(source)
  if (andParts.length > 1) {
    const names = andParts.map(parseOneName).filter((name) => name !== null)
    return names
  }
  const commaParts = source.split(',').map((part) => part.trim())
  if (commaParts.length === 1) {
    const one = parseOneName(source)
    return one === null ? [] : [one]
  }
  if (commaParts.length === 2) {
    if (looksLikeFamilyGiven(commaParts[0]) && looksLikeFamilyGiven(commaParts[1])) {
      return commaParts.map(parseOneName).filter((name) => name !== null)
    }
    const one = parseOneName(source)
    return one === null ? [] : [one]
  }
  if (commaParts.every(looksLikeFamilyGiven)) {
    return commaParts.map(parseOneName).filter((name) => name !== null)
  }
  // `Smith, J., Jones, A.` — a family/given pair per two commas.
  if (
    commaParts.length % 2 === 0 &&
    commaParts.every((part, index) => (index % 2 === 1 ? part === '' || /^[A-Z]/.test(part) : part !== ''))
  ) {
    const names = []
    for (let index = 0; index < commaParts.length; index += 2) {
      names.push({ family: commaParts[index], given: commaParts[index + 1] })
    }
    return names
  }
  const one = parseOneName(source)
  return one === null ? [] : [one]
}

/**
 * One name as `Family, Given`, ALWAYS with the comma.
 *
 * The comma is what makes the pair readable again: `Organization,` is one family
 * and an empty given name, while `Organization` is a two-word personal name to
 * every parser that follows the space convention — so the comma is written even
 * when the given name is empty, and a corporate author survives the round trip
 * without a field being invented to carry it.
 */
function commaName(name) {
  const family = collapse(name.family)
  const given = collapse(name.given)
  if (given === '') return family + ','
  return family + ', ' + given
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------
/**
 * `XX  - value` — two spaces, a hyphen, a space, which is the standard.
 *
 * Real exports use one space and tabs as well (Zotero, EndNote and a dozen
 * library scripts have each emitted their own spacing), so the separator is
 * matched leniently: `\s{1,2}` accepts one space, two spaces or a tab. A line
 * this pattern rejects is not a tag line and is ignored rather than guessed at.
 */
const RIS_LINE = /^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/

/**
 * RIS type -> kind, for the types with an unambiguous kind.
 *
 * Anything else falls through to `risFallbackKind`, because a type this module
 * cannot identify must not be reported as a journal article by default: an
 * article claims a container (the journal) that the record does not have.
 */
const RIS_KIND = {
  JOUR: 'journal-article',
  BOOK: 'book',
  CHAP: 'chapter',
  CONF: 'conference-paper',
  RPRT: 'report',
  THES: 'thesis',
  ELEC: 'web',
  WEB: 'web',
  DATA: 'dataset',
}

/** The kind of a RIS type this module does not map: a journal article only when
 *  the record actually names a JOURNAL (`JO`/`JF`), and a report otherwise. A
 *  `T2` book title is not evidence of an article, so it does not count here. */
function risFallbackKind(journal) {
  return journal === '' ? 'report' : 'journal-article'
}

/** kind -> the RIS tag to write. The last two are RIS's own tags for an
 *  unpublished work and a standard; both read back as `report`/
 *  `journal-article`, which is exactly what RIS carries. */
const RIS_TYPE = {
  'journal-article': 'JOUR',
  book: 'BOOK',
  chapter: 'CHAP',
  'conference-paper': 'CONF',
  report: 'RPRT',
  thesis: 'THES',
  web: 'ELEC',
  dataset: 'DATA',
  preprint: 'UNPB',
  standard: 'STD',
}

/** The tags that hold a container, in the order that prefers a journal. */
function risFields(tags) {
  const first = (tag) => {
    const list = tags.get(tag)
    return list === undefined || list.length === 0 ? '' : collapse(list[0])
  }
  const all = (tag) => (tags.get(tag) ?? []).map((value) => collapse(value)).filter((value) => value !== '')
  const type = first('TY').toUpperCase()
  const journal = first('JO') || first('JF')
  const container = journal || first('T2') || first('BT')
  const fields = blankRecord()
  fields.kind = RIS_KIND[type] ?? risFallbackKind(journal)
  fields.key = keyFrom(first('ID'))
  fields.title = first('TI') || first('T1')
  fields.authors = all('AU').flatMap((value) => parseAuthors(value))
  fields.editor = all('A2').flatMap((value) => parseAuthors(value))
  fields.year = yearOf(first('PY') || first('DA'))
  fields.container = container
  fields.volume = first('VL')
  fields.issue = first('IS')
  fields.pages = joinPages(first('SP'), first('EP'))
  fields.edition = first('ET')
  fields.publisher = first('PB')
  fields.place = first('CY') || first('PP')
  fields.doi = doiOf(first('DO'))
  fields.url = first('UR') || first('L1')
  fields.accessed = first('Y2')
  fields.note = mergeNote(first('N1'), first('AB'))
  for (const serial of all('SN')) assignSerial(fields, serial)
  return fields
}

/**
 * Read an RIS file.
 *
 * `TY` opens a record and `ER` closes it; `AU` and `A2` repeat, one name per
 * line. Lines before the first `TY` belong to no record (some exporters prepend
 * a header) and are ignored, and a record whose `ER` never arrives is still read,
 * because a truncated download that loses the last line should lose the last
 * line, not the whole citation.
 *
 * `warnings` is optional and collects the records this file could not cite.
 */
export function importRis(text, warnings) {
  const records = []
  let tags = null
  const flush = () => {
    if (tags === null) return
    const record = makeRecord(risFields(tags), warnings)
    if (record !== null) records.push(record)
    tags = null
  }
  for (const line of splitLines(text)) {
    const match = RIS_LINE.exec(line)
    if (match === null) continue
    const tag = match[1]
    const value = match[2].trim()
    if (tag === 'TY') {
      // A second `TY` without an `ER` means the previous record's terminator was
      // lost; the record it opened is still complete enough to keep.
      flush()
      tags = new Map()
      tags.set(tag, [value])
      continue
    }
    if (tags === null) continue
    if (tag === 'ER') {
      flush()
      continue
    }
    const list = tags.get(tag)
    if (list === undefined) tags.set(tag, [value])
    else list.push(value)
  }
  flush()
  return records
}

/** One `XX  - value` line, or nothing when the value is empty. Every value is
 *  collapsed: RIS is line based, so a value holding a newline would split into a
 *  line that reads as a tag of its own. */
function risLine(tag, value) {
  const written = collapse(value)
  return written === '' ? null : tag + '  - ' + written
}

/** Records as an RIS file. Empty in, empty out — no stray blank line. */
export function renderRis(records) {
  const lines = []
  for (const raw of listOf(records)) {
    const record = normaliseRecord(raw)
    const kind = record.kind === '' ? 'report' : record.kind
    const type = RIS_TYPE[kind] ?? 'GEN'
    lines.push('TY  - ' + type)
    for (const line of [
      record.key === '' ? null : 'ID  - ' + collapse(record.key),
      // The container tag follows the entry: a journal article's container is
      // its journal, and every other kind's container is the thing it sits in.
      ...risNameLines('AU', record.authors),
      ...risNameLines('A2', record.editor),
      risLine('TI', record.title),
      risLine(kind === 'journal-article' || kind === 'preprint' ? 'JO' : 'T2', record.container),
      risLine('VL', record.volume),
      risLine('IS', record.issue),
      ...risPageLines(record.pages),
      risLine('ET', record.edition),
      risLine('PB', record.publisher),
      risLine('CY', record.place),
      risLine('PY', record.year),
      risLine('SN', record.issn),
      risLine('SN', record.isbn),
      risLine('DO', record.doi),
      risLine('UR', record.url),
      risLine('Y2', record.accessed),
      risLine('N1', record.note),
    ]) {
      if (line !== null) lines.push(line)
    }
    lines.push('ER  - ')
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n'
}

function risNameLines(tag, names) {
  return names.map((name) => tag + '  - ' + commaName(name))
}

function risPageLines(pages) {
  const { start, end } = splitPages(pages)
  if (start === '' && end === '') return []
  const lines = [risLine('SP', start)]
  const last = risLine('EP', end)
  if (last !== null) lines.push(last)
  return lines.filter((line) => line !== null)
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------
/**
 * A BibTeX value is not a string, and that is why this module scans braces
 * instead of matching a pattern: a value may nest `{}` (to protect a
 * capitalisation, `{The {NASA} study}`), may be quoted instead of braced, may be
 * a bare number, and may be split across lines. A regular expression over
 * `field = value` either stops at the first inner brace or swallows the next
 * field, and both failures are silent.
 *
 * `@string`, `@preamble` and `@comment` are not records and are skipped.
 */
const BIB_OPEN = /@([A-Za-z]+)\s*([({])/g

/** The index of the `}` that closes the `{` at `start`, or -1. */
function matchingBrace(value, start) {
  let depth = 0
  for (let index = start; index < value.length; index += 1) {
    const ch = value[index]
    if (ch === '\\') {
      index += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Every `@type{...}` entry, with its body, whatever separates the entries. */
function bibEntries(source) {
  const entries = []
  BIB_OPEN.lastIndex = 0
  let match
  while ((match = BIB_OPEN.exec(source)) !== null) {
    const type = match[1].toLowerCase()
    const opener = match[2]
    const start = match.index + match[0].length
    let end = -1
    if (opener === '{') {
      end = matchingBrace(source, start - 1)
    } else {
      // A parenthesised entry closes at its own `)`; braces inside it are
      // balanced markup and are counted so a `)` inside a value cannot end it.
      let braces = 0
      for (let index = start; index < source.length; index += 1) {
        const ch = source[index]
        if (ch === '\\') {
          index += 1
          continue
        }
        if (ch === '{') braces += 1
        else if (ch === '}') braces = braces > 0 ? braces - 1 : 0
        else if (ch === ')' && braces === 0) {
          end = index
          break
        }
      }
    }
    if (end === -1) {
      // An entry that never closes cannot be read and cannot be repaired; the
      // scan continues after it so one broken entry does not hide the rest.
      BIB_OPEN.lastIndex = start
      continue
    }
    BIB_OPEN.lastIndex = end + 1
    if (type === 'string' || type === 'preamble' || type === 'comment') continue
    entries.push({ type, body: source.slice(start, end) })
  }
  return entries
}

/** Split on one separator character that is at brace depth 0, outside a quoted
 *  string and not escaped. This is what keeps a comma inside `{Smith, J.}` from
 *  looking like the end of a field. */
function splitTop(value, separator) {
  const parts = []
  let depth = 0
  let quote = false
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]
    if (ch === '\\') {
      index += 1
      continue
    }
    if (quote) {
      if (ch === '"') quote = false
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      if (depth > 0) depth -= 1
    } else if (ch === '"' && depth === 0) quote = true
    else if (ch === separator && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/** A value with its delimiters gone: `{...}`, `"..."`, or bare. A `#` joins
 *  BibTeX's concatenated pieces back into the one value they spell. */
function bibRawValue(value) {
  const pieces = splitTop(value, '#').map((piece) => {
    const source = piece.trim()
    if (source.length >= 2 && source.startsWith('{') && matchingBrace(source, 0) === source.length - 1) {
      return source.slice(1, -1)
    }
    if (source.length >= 2 && source.startsWith('"') && source.endsWith('"')) {
      return source.slice(1, -1)
    }
    return source
  })
  return pieces.join('')
}

/** An entry body as its key and its fields. The first occurrence of a field
 *  wins, so a duplicated `title` cannot silently replace the one the entry was
 *  read for. */
function bibFields(body) {
  const parts = splitTop(body, ',')
  const key = parts.length > 0 ? parts[0].trim() : ''
  const fields = new Map()
  for (let index = 1; index < parts.length; index += 1) {
    const chunk = parts[index]
    const equals = chunk.indexOf('=')
    if (equals === -1) continue
    const name = chunk.slice(0, equals).trim().toLowerCase()
    if (name === '') continue
    if (fields.has(name)) continue
    fields.set(name, bibRawValue(chunk.slice(equals + 1)))
  }
  return { key, fields }
}

const BIB_ACCENTS = new Map([
  ['"', '\u0308'],
  ["'", '\u0301'],
  ['`', '\u0300'],
  ['^', '\u0302'],
  ['~', '\u0303'],
  ['=', '\u0304'],
  ['.', '\u0307'],
  ['c', '\u0327'],
  ['v', '\u030c'],
  ['u', '\u0306'],
  ['H', '\u030b'],
  ['r', '\u030a'],
  ['k', '\u0328'],
  ['d', '\u0323'],
  ['b', '\u0331'],
])

/** The emphasis commands whose braces are markup around a word. */
const BIB_EMPHASIS =
  /\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|textsuperscript|textsubscript|textnormal|mbox|hbox|mathrm|mathit)\s*\{([^{}]*)\}/g

/**
 * A BibTeX value as the text it stands for.
 *
 * The small set of LaTeX this module knows is `{\"u}`-style accents, the
 * escaped characters, the emphasis commands around a word, and `~` as a
 * non-breaking space in prose — because a bibliography is read as text, and
 * `M{\"u}ller` in a reference list is a defect, not fidelity. Everything else is
 * left exactly as it was written rather than guessed at: a command this module
 * does not know may be load-bearing for the style that prints it.
 *
 * `prose` is false for identifiers (a URL, a DOI, a serial number), where `~` is
 * a character of the identifier and not a space.
 */
function bibText(value, prose) {
  let out = String(value ?? '')
  out = out.replace(BIB_EMPHASIS, '$1')
  out = out.replace(/\\(['"`^~=.])\s*\{?([A-Za-z])\}?/g, (whole, accent, letter) => letter + BIB_ACCENTS.get(accent))
  out = out.replace(/\\([cvuHrkdb])\s*\{([A-Za-z])\}/g, (whole, accent, letter) => letter + (BIB_ACCENTS.get(accent) ?? ''))
  // Braces that are left are capitalisation protection, which is markup: they
  // are removed. An ESCAPED brace is a literal one and survives to be unescaped
  // in the next step, which is why this one looks behind it.
  out = out.replace(/(?<!\\)[{}]/g, '')
  out = out.replace(/\\([&%$#_{}])/g, '$1')
  out = out.replace(/\\textasciitilde\b/g, '~').replace(/\\textasciicircum\b/g, '^')
  if (prose) out = out.replace(/~/g, ' ')
  return collapse(out).normalize('NFC')
}

/** A field of an entry, as text. */
function bibField(fields, name, prose) {
  const raw = fields.get(name)
  if (raw === undefined) return ''
  return bibText(raw, prose !== false)
}

function bibFirst(fields, names, prose) {
  for (const name of names) {
    const value = bibField(fields, name, prose)
    if (value !== '') return value
  }
  return ''
}

/** Entry type -> kind, for the types with one unambiguous kind. `@misc` is
 *  deliberately absent: it carries no kind by itself and takes the fallback. */
const BIB_KIND = {
  article: 'journal-article',
  book: 'book',
  inbook: 'chapter',
  incollection: 'chapter',
  inproceedings: 'conference-paper',
  conference: 'conference-paper',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  online: 'web',
  electronic: 'web',
  unpublished: 'preprint',
}

/** The kind of an entry type this module does not map (`@misc` above all): a
 *  report only when the entry says it is one, a web page when it names a URL,
 *  and otherwise a report — the one kind that claims nothing about a container. */
function bibFallbackKind(fields) {
  const institution = bibFirst(fields, ['institution', 'howpublished'])
  if (institution !== '') return 'report'
  if (bibFirst(fields, ['url']) !== '') return 'web'
  return 'report'
}

const BIB_TYPE = {
  'journal-article': 'article',
  book: 'book',
  chapter: 'incollection',
  'conference-paper': 'inproceedings',
  report: 'techreport',
  thesis: 'phdthesis',
  web: 'online',
  preprint: 'unpublished',
  // BibTeX's entry vocabulary has no entry for either of these; `@misc` is the
  // honest place for them, and the loss of the kind is documented above.
  dataset: 'misc',
  standard: 'misc',
}

function bibRecord(entry) {
  const { key, fields } = bibFields(entry.body)
  const record = blankRecord()
  record.kind = BIB_KIND[entry.type] ?? bibFallbackKind(fields)
  // The entry's own key is its identity and is kept: it is what the document
  // that came with the file already cites. It is passed through `keyFrom`
  // because the record's key is `[a-z0-9-]` by contract and a BibTeX key may
  // contain `:` or `_`.
  record.key = keyFrom(key)
  record.title = bibFirst(fields, ['title'])
  record.authors = parseAuthors(bibField(fields, 'author'))
  record.editor = parseAuthors(bibField(fields, 'editor'))
  record.year = yearOf(bibFirst(fields, ['year', 'date']))
  // `journal` is the journal of an article, `booktitle` the book or proceedings
  // an entry sits in, and `journaltitle` biblatex's generic container — the
  // order that prefers the most specific field present.
  record.container =
    entry.type === 'article'
      ? bibFirst(fields, ['journal', 'journaltitle'])
      : bibFirst(fields, ['booktitle', 'journal', 'journaltitle'])
  record.volume = bibFirst(fields, ['volume'])
  record.issue = bibFirst(fields, ['number', 'issue'])
  record.pages = normalisePages(bibFirst(fields, ['pages']))
  record.edition = bibFirst(fields, ['edition'])
  // `institution` and `school` are BibTeX's own publisher fields for a report and
  // a thesis; reading them means a real `.bib` from a reference manager keeps its
  // publisher, and writing `publisher` means one key is written and read.
  record.publisher = bibFirst(fields, ['publisher', 'institution', 'school', 'organization'])
  record.place = bibFirst(fields, ['address', 'location'])
  record.doi = doiOf(bibFirst(fields, ['doi']))
  record.url = bibFirst(fields, ['url'], false)
  record.isbn = bibFirst(fields, ['isbn'], false)
  record.issn = bibFirst(fields, ['issn'], false)
  record.accessed = bibFirst(fields, ['urldate'], false)
  record.note = bibFirst(fields, ['note'])
  return record
}

/**
 * Read a BibTeX file. Every entry except `@string`/`@preamble`/`@comment` is a
 * record, and an unknown entry type still yields a record — its kind comes from
 * `@misc`'s rule, so an unfamiliar type is never reported as something nobody
 * chose.
 */
export function importBib(text, warnings) {
  const records = []
  for (const entry of bibEntries(String(text ?? ''))) {
    const record = makeRecord(bibRecord(entry), warnings)
    if (record !== null) records.push(record)
  }
  return records
}

/** A value inside `{...}`, with a lone brace escaped.
 *
 *  BibTeX is read by brace matching, so one unbalanced brace in a title makes
 *  every entry after it unreadable — by this module, by Zotero and by LaTeX.
 *  Balanced braces are markup and are written as they are; an unbalanced value
 *  has every brace escaped, which the reader turns back into the literal text.
 */
function bibValue(value) {
  const source = collapse(value)
  if (source === '') return null
  let depth = 0
  let balanced = true
  for (const ch of source) {
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth < 0) balanced = false
    }
  }
  if (depth !== 0) balanced = false
  const escaped = balanced ? source : source.replace(/\{/g, '\\{').replace(/\}/g, '\\}')
  return '{' + escaped + '}'
}

function bibLine(name, value) {
  const written = bibValue(value)
  return written === null ? null : '  ' + name + ' = ' + written
}

/** Records as a `.bib`, one entry per record, blank line between them. */
export function renderBib(records) {
  const entries = []
  for (const raw of listOf(records)) {
    const record = normaliseRecord(raw)
    const kind = record.kind === '' ? 'report' : record.kind
    const type = BIB_TYPE[kind] ?? 'misc'
    const containerField =
      type === 'article' ? null : type === 'incollection' || type === 'inproceedings' ? 'booktitle' : 'journaltitle'
    const key = record.key === '' ? suggestKey(record) : keyFrom(record.key)
    // The opener carries NO trailing comma of its own: the join below is what
    // separates the fields, and a comma written here as well would produce
    // `@article{key,, author = …}` — an empty field name, which every BibTeX
    // reader rejects. There is no comma after the LAST field either, because a
    // file a person opens in an editor should look like one a tool wrote.
    const opener = '@' + type + '{' + key
    const fields = []
    for (const line of [
      bibLine('author', record.authors.map(commaName).join(' and ')),
      bibLine('editor', record.editor.map(commaName).join(' and ')),
      bibLine('title', record.title),
      containerField === null ? bibLine('journal', record.container) : bibLine(containerField, record.container),
      bibLine('year', record.year),
      bibLine('volume', record.volume),
      bibLine('number', record.issue),
      // `45-67` is written `45--67`, which is how a BibTeX style prints a range.
      bibLine('pages', reRange(record.pages)),
      bibLine('edition', record.edition),
      bibLine('publisher', record.publisher),
      bibLine('address', record.place),
      bibLine('doi', record.doi),
      bibLine('url', record.url),
      bibLine('isbn', record.isbn),
      bibLine('issn', record.issn),
      bibLine('urldate', record.accessed),
      bibLine('note', record.note),
    ]) {
      if (line !== null) fields.push(line)
    }
    entries.push(fields.length === 0 ? opener + '}' : opener + ',\n' + fields.join(',\n') + '\n}')
  }
  return entries.length === 0 ? '' : entries.join('\n\n') + '\n'
}

/** `45-67` -> `45--67`, which is how a BibTeX style prints a range, and a page
 *  that only has one end (`e12345`) left exactly as it is. */
function reRange(pages) {
  const source = normalisePages(pages)
  const match = /^(\S+?)-(\S+)$/.exec(source)
  if (match === null) return source
  return match[1] + '--' + match[2]
}

// ---------------------------------------------------------------------------
// PubMed / MEDLINE (nbib)
// ---------------------------------------------------------------------------
/** `TAG- value`, the MEDLINE tag line. */
const NBIB_LINE = /^([A-Z][A-Z0-9]{1,3})\s*-\s?(.*)$/

/** `10.1234/abcd [doi]` — the trailing tag is what says which identifier this
 *  is; `LID` and `AID` carry DOIs and publisher ids and PubMed's own ids alike. */
const NBIB_DOI = /^(\S+)\s+\[doi\]$/i

function nbibFields(tags) {
  const first = (tag) => {
    const list = tags.get(tag)
    return list === undefined || list.length === 0 ? '' : collapse(list[0])
  }
  const all = (tag) => (tags.get(tag) ?? []).map((value) => collapse(value)).filter((value) => value !== '')
  const fields = blankRecord()
  // MEDLINE indexes journal articles; no tag in this set carries any other type.
  fields.kind = 'journal-article'
  fields.title = first('TI')
  fields.authors = all('AU').flatMap((value) => parseAuthors(value))
  fields.container = first('JT') || first('TA')
  fields.year = yearOf(first('DP'))
  fields.volume = first('VI')
  fields.issue = first('IP')
  fields.pages = normalisePages(first('PG'))
  fields.note = mergeNote(first('AB'), '')
  for (const tag of ['LID', 'AID']) {
    for (const value of all(tag)) {
      const match = NBIB_DOI.exec(value)
      if (match === null || fields.doi !== '') continue
      fields.doi = doiOf(match[1])
    }
  }
  // A MEDLINE author list is one name per `AU` line; there is no key, and
  // `LA`/`PMID`/`SO` have no field in this shape and are read past rather than
  // invented into `note`.
  return fields
}

/**
 * Read a PubMed/MEDLINE file.
 *
 * Records start at `PMID- ` and are separated by a blank line, but the real
 * structural fact is the WRAPPING: MEDLINE hard wraps a long title at 72 columns
 * with no marker of its own, so the only thing that says "this belongs to the
 * line above" is the leading whitespace. Those lines are joined with a single
 * space, because the wrap is a column limit and not part of the value — joining
 * without a space would run two words together.
 */
export function importNbib(text, warnings) {
  const records = []
  let tags = null
  let lastTag = null
  const flush = () => {
    if (tags === null) return
    const record = makeRecord(nbibFields(tags), warnings)
    if (record !== null) records.push(record)
    tags = null
    lastTag = null
  }
  for (const line of splitLines(text)) {
    if (line.trim() === '') {
      flush()
      continue
    }
    if (/^\s/.test(line)) {
      if (tags !== null && lastTag !== null) {
        const list = tags.get(lastTag)
        list[list.length - 1] = collapse(list[list.length - 1] + ' ' + line)
      }
      continue
    }
    const match = NBIB_LINE.exec(line)
    if (match === null) continue
    const tag = match[1]
    if (tag === 'PMID') flush()
    if (tags === null) tags = new Map()
    const value = match[2].trim()
    const list = tags.get(tag)
    if (list === undefined) tags.set(tag, [value])
    else list.push(value)
    lastTag = tag
  }
  flush()
  return records
}

// ---------------------------------------------------------------------------
// EndNote tagged (enw)
// ---------------------------------------------------------------------------
/** `%TAG value` — one character of tag, then the value. */
const ENW_LINE = /^%(\S)\s?(.*)$/

/** `%0` type -> kind, matched case-insensitively. `Book Section` is EndNote's
 *  name for a chapter, which is the one that catches people out. */
const ENW_KIND = {
  'journal article': 'journal-article',
  article: 'journal-article',
  'electronic article': 'journal-article',
  book: 'book',
  'electronic book': 'book',
  'book section': 'chapter',
  'conference paper': 'conference-paper',
  'conference proceedings': 'conference-paper',
  thesis: 'thesis',
  report: 'report',
  'web page': 'web',
  dataset: 'dataset',
  preprint: 'preprint',
  standard: 'standard',
}

const ENW_TYPE = {
  'journal-article': 'Journal Article',
  book: 'Book',
  chapter: 'Book Section',
  'conference-paper': 'Conference Paper',
  thesis: 'Thesis',
  report: 'Report',
  web: 'Web Page',
  dataset: 'Dataset',
  preprint: 'Preprint',
  standard: 'Standard',
}

/** The kind of a `%0` this module does not map: the same rule RIS uses, so an
 *  unfamiliar type is not silently called a journal article. */
function enwFallbackKind(container) {
  return container === '' ? 'report' : 'journal-article'
}

function enwFields(tags) {
  const first = (tag) => {
    const list = tags.get(tag)
    return list === undefined || list.length === 0 ? '' : collapse(list[0])
  }
  const all = (tag) => (tags.get(tag) ?? []).map((value) => collapse(value)).filter((value) => value !== '')
  const type = first('0').toLowerCase().replace(/\s+/g, ' ')
  // `%B` is the book of a Book Section and `%J` is the journal of an article:
  // one of the two is always the container, whichever the exporter wrote.
  const container = first('J') || first('B')
  const fields = blankRecord()
  fields.kind = ENW_KIND[type] ?? enwFallbackKind(container)
  fields.key = keyFrom(first('F'))
  fields.title = first('T')
  fields.authors = all('A').flatMap((value) => parseAuthors(value))
  fields.editor = all('E').flatMap((value) => parseAuthors(value))
  fields.year = yearOf(first('D')) || yearOf(first('8'))
  fields.container = container
  fields.volume = first('V')
  fields.issue = first('N')
  fields.pages = normalisePages(first('P'))
  fields.edition = first('7')
  fields.publisher = first('I')
  fields.place = first('C')
  fields.doi = doiOf(first('R'))
  fields.url = first('U')
  assignSerial(fields, first('@'))
  fields.note = mergeNote(first('Z'), first('X'))
  return fields
}

/**
 * Read an EndNote tagged file.
 *
 * `%0` opens a record. A line that does not begin with a `%tag` is a continuation
 * of the line above, joined with one space for the same reason MEDLINE's wrapping
 * is: the break belongs to the exporter's column width, not to the value.
 */
export function importEnw(text, warnings) {
  const records = []
  let tags = null
  let lastTag = null
  const flush = () => {
    if (tags === null) return
    const record = makeRecord(enwFields(tags), warnings)
    if (record !== null) records.push(record)
    tags = null
    lastTag = null
  }
  for (const line of splitLines(text)) {
    const match = ENW_LINE.exec(line)
    if (match === null) {
      if (tags !== null && lastTag !== null && line.trim() !== '') {
        const list = tags.get(lastTag)
        list[list.length - 1] = collapse(list[list.length - 1] + ' ' + line)
      }
      continue
    }
    const tag = match[1]
    if (tag === '0') flush()
    if (tags === null) tags = new Map()
    const value = match[2].trim()
    const list = tags.get(tag)
    if (list === undefined) tags.set(tag, [value])
    else list.push(value)
    lastTag = tag
  }
  flush()
  return records
}

/** One `%TAG value` line, or nothing for an empty value. */
function enwLine(tag, value) {
  const written = collapse(value)
  return written === '' ? null : '%' + tag + ' ' + written
}

/** Records as an EndNote tagged file, a blank line between records — which is
 *  what every EndNote export looks like and what its own importer expects. */
export function renderEnw(records) {
  const blocks = []
  for (const raw of listOf(records)) {
    const record = normaliseRecord(raw)
    const kind = record.kind === '' ? 'report' : record.kind
    const type = ENW_TYPE[kind] ?? 'Report'
    const lines = ['%0 ' + type]
    if (record.key !== '') lines.push('%F ' + collapse(record.key))
    for (const name of record.authors) lines.push('%A ' + commaName(name))
    for (const name of record.editor) lines.push('%E ' + commaName(name))
    for (const line of [
      enwLine('T', record.title),
      // `%J` is the journal and the book of a section alike: EndNote keeps one
      // container tag for both, and `%B` is read as its alias on the way in.
      enwLine('J', record.container),
      enwLine('V', record.volume),
      enwLine('N', record.issue),
      enwLine('P', record.pages),
      enwLine('7', record.edition),
      enwLine('D', record.year),
      enwLine('I', record.publisher),
      enwLine('C', record.place),
      // `%@` is the serial number tag: ISBN in one entry type and ISSN in the
      // next, and only the number's shape says which.
      enwLine('@', record.isbn || record.issn),
      enwLine('R', record.doi),
      enwLine('U', record.url),
      enwLine('Z', record.note),
    ]) {
      if (line !== null) lines.push(line)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.length === 0 ? '' : blocks.join('\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------
/** The formats `importCitations` can dispatch to, in the order it tries them. */
export const CITATION_FORMATS = Object.freeze(['ris', 'bibtex', 'nbib', 'enw'])

/** Whether a line is the RIS tag `TY` or `ER`, which no other format writes. */
function hasRisLine(lines, tag) {
  return lines.some((line) => {
    const match = RIS_LINE.exec(line)
    return match !== null && match[1] === tag
  })
}

/**
 * Which format this text is, or null.
 *
 * The signals are the ones a format cannot avoid writing: RIS opens with `TY`
 * and closes with `ER`, BibTeX has an `@type{`, MEDLINE has `PMID- `, and
 * EndNote tags have `%0`. Each is checked before the weaker one after it, and a
 * text with none of them is not guessed at — see `importCitations`.
 */
export function sniffFormat(text) {
  const source = String(text ?? '')
  const lines = splitLines(source)
  if (hasRisLine(lines, 'TY') || hasRisLine(lines, 'ER')) return 'ris'
  if (/^[ \t]*@[A-Za-z]+[ \t]*[({]/m.test(source)) return 'bibtex'
  if (/^PMID-[ \t]/m.test(source)) return 'nbib'
  if (/^%0[ \t]/m.test(source) || /^%[A-Za-z0-9@][ \t]/m.test(source)) return 'enw'
  return null
}

/** What a text that IS not a known format does look like, so the refusal can
 *  name what it saw instead of only what it wanted. */
function formatEvidence(source) {
  const evidence = []
  const lines = splitLines(source)
  if (lines.some((line) => /^[ \t]*[A-Z][A-Z0-9][ \t]{1,2}-/.test(line))) evidence.push('RIS-shaped `XX  - value` lines but no `TY`/`ER`')
  if (lines.some((line) => /^[ \t]*%/.test(line))) evidence.push('lines starting with `%` but no `%0`')
  if (lines.some((line) => /^[A-Z][A-Z0-9]{1,3}[ \t]*-[ \t]/.test(line))) evidence.push('tagged `XX- value` lines but no `PMID- `')
  if (/^[ \t]*@/m.test(source)) evidence.push('an `@` but no BibTeX entry opener')
  if (/^[ \t]*[[{]/.test(source)) evidence.push('a leading `[` or `{`, which is JSON and not a citation file')
  return evidence
}

/**
 * Read a citation file in whichever format it is, with the records this file
 * could not cite reported rather than thrown.
 *
 * Empty input is an empty list and not an error: a person who pastes nothing has
 * cited nothing. Text that is NOT any known format is a refusal with a code,
 * because silently returning no records would look exactly like a file that
 * parsed to nothing, and the caller would go looking for the bug in the wrong
 * place.
 */
export function importCitationsReport(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return { format: null, records: [], dropped: [] }
  const format = sniffFormat(source)
  if (format === null) {
    const evidence = formatEvidence(source)
    throw new ResearchError(
      'REFS_FORMAT',
      'this is not a citation file in any format this engine reads' +
        (evidence.length === 0 ? '' : ' — it did contain ' + evidence.join('; ')) +
        '. Expected RIS (`TY  - JOUR` … `ER  - `), BibTeX (`@article{key, …`), PubMed/MEDLINE (`PMID- `) or EndNote tagged (`%0 …`)',
    )
  }
  const dropped = []
  const records =
    format === 'ris'
      ? importRis(source, dropped)
      : format === 'bibtex'
        ? importBib(source, dropped)
        : format === 'nbib'
          ? importNbib(source, dropped)
          : importEnw(source, dropped)
  return { format, records, dropped }
}

/** Read a citation file in whichever format it is. */
export function importCitations(text) {
  return importCitationsReport(text).records
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
/** A records argument may be one record or a list of them, because a caller who
 *  has one record should not have to wrap it in an array to write it out. */
function listOf(records) {
  if (records === null || records === undefined) return []
  return Array.isArray(records) ? records : [records]
}
