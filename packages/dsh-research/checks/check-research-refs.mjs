// check-research-refs.mjs - the dsh-research bibliographic engine, driven directly.
//
// What this proves, and why each half is here:
//
//   - the RECORD is one shape: every importer produces exactly the same keys in
//     the same order, so a styles module downstream can never meet a record with
//     a missing field or a literal `undefined`;
//   - the three renderers ROUND TRIP: for each format, `importX(renderX(records))`
//     returns the same key, kind, title, authors, year, container, editor,
//     volume, issue, pages, edition, publisher, place, doi, url, isbn, issn and
//     note for a fixture covering article, book, chapter, conference, report,
//     web, thesis and dataset - and a second render is byte identical, so the
//     round trip is a fixed point rather than a slow drift;
//   - what a format CANNOT carry is asserted as a loss instead of being hidden:
//     RIS has no preprint, so a preprint comes back a journal article; BibTeX has
//     no dataset entry, so a dataset comes back a web page; EndNote tagged has no
//     access date. Each of those is pinned below by its own check;
//   - the PARSING is driven on text a real exporter would write: one-space and
//     tab RIS separators, CRLF, an unterminated last record, BibTeX brace
//     nesting and `\"u` escapes and a parenthesised entry, MEDLINE's hard wrap,
//     EndNote's `%B` for a section and its `%@` meaning ISBN in one entry and
//     ISSN in the next;
//   - the REFUSALS are the engine's, read by code: empty input is an empty list,
//     and text in no known format is `REFS_FORMAT` with what it DID recognise in
//     the message;
//   - the DROP rule is the only rejection there is, and it is reported.
//
// There is no skip path in this check on purpose: the module is pure string
// functions over built-in objects, so every branch runs on every host, and a
// `SKIP` line here would be a branch nobody had ever seen execute.
//
// Run:  node packages/dsh-research/checks/check-research-refs.mjs
export {}

const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')

const refsUrl = new URL('../lib/refs.js', import.meta.url)
const refsPath = fileURLToPath(refsUrl)
const refs = await import(refsUrl.href)

const {
  KINDS,
  RECORD_FIELDS,
  CITATION_FORMATS,
  blankRecord,
  importBib,
  importCitations,
  importCitationsReport,
  importEnw,
  importNbib,
  importRis,
  keyFrom,
  normaliseRecord,
  parseAuthors,
  renderBib,
  renderEnw,
  renderRis,
  sniffFormat,
  suggestKey,
} = refs

let failures = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(44) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** The `code` of a refusal, whatever was thrown. */
function codeOf(fn) {
  try {
    fn()
    return '(no error)'
  } catch (err) {
    return err && err.code ? String(err.code) : 'THREW:' + (err && err.message ? err.message : String(err))
  }
}

/** The `message` of a refusal, whatever was thrown. */
function messageOf(fn) {
  try {
    fn()
    return '(no error)'
  } catch (err) {
    return err && err.message ? String(err.message) : String(err)
  }
}

console.log('check-research-refs: the record, the four readers, the three writers, the round trips')

// ---------------------------------------------------------------------------
// The shape of a record
// ---------------------------------------------------------------------------
const RECORD_KEYS =
  'key,kind,title,authors,year,container,editor,volume,issue,pages,edition,publisher,place,doi,url,isbn,issn,accessed,note'
{
  check('the declared scalar fields are the shape', RECORD_FIELDS.join(','), RECORD_KEYS.split(',').filter((key) => key !== 'authors' && key !== 'editor').join(','))
  check('a blank record carries every key', Object.keys(blankRecord()).join(','), RECORD_KEYS)
  check('an absent value is an empty string', blankRecord().doi, '')
  check('an absent name list is an empty array', JSON.stringify(blankRecord().authors), '[]')
  check('a record built from nothing has no undefined', JSON.stringify(normaliseRecord(null)).includes('undefined'), false)
  check('a hand-built record is filled out too', normaliseRecord({ title: 'x' }).volume, '')
  check('a DOI stored as a URL becomes a DOI', normaliseRecord({ doi: 'https://doi.org/10.1/x' }).doi, '10.1/x')
  check('and the `doi:` prefix is one too', normaliseRecord({ doi: 'doi:10.1/x' }).doi, '10.1/x')
  check('the kind vocabulary is closed', KINDS.includes('conference-paper') && KINDS.includes('dataset'), true)
  check('four formats can be sniffed', CITATION_FORMATS.join(','), 'ris,bibtex,nbib,enw')
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
{
  check('keyFrom folds accents', keyFrom('Müller'), 'muller')
  check('keyFrom collapses a run of junk into one dash', keyFrom('  --a  &  b--  '), 'a-b')
  check('keyFrom trims the dashes it made', keyFrom('!!!hello!!!'), 'hello')
  check('keyFrom of nothing is nothing', keyFrom(''), '')
  check('keyFrom is idempotent', keyFrom(keyFrom('A: B/C')), keyFrom('A: B/C'))

  check(
    'suggestKey: the documented example',
    suggestKey({ authors: [{ family: 'Smith', given: 'J.' }], year: '2024', title: 'The effect of X on Y' }),
    'smith2024effect',
  )
  check('suggestKey is legal lower-case [a-z0-9-]', /^[a-z0-9-]+$/.test(suggestKey({ authors: [{ family: 'Ødegård', given: 'A.' }], year: '2021', title: 'Studying: things!' })), true)
  check('suggestKey has no trailing dash', suggestKey({ authors: [{ family: 'Smith', given: '' }], year: '2024', title: 'A' }).endsWith('-'), false)
  const longTitle =
    'An extraordinarily long and repetitive title about the environmental consequences of everything that has ever happened'
  const longKey = suggestKey({ authors: [{ family: 'Smith', given: 'J.' }], year: '2024', title: longTitle })
  check('suggestKey truncates to 40 characters', longKey.length <= 40, true)
  check('and the truncation leaves no trailing dash', longKey.endsWith('-'), false)
  check('suggestKey is stable', suggestKey({ authors: [{ family: 'Smith', given: 'J.' }], year: '2024', title: longTitle }), longKey)
  check('suggestKey takes at most three title words', suggestKey({ authors: [{ family: 'Brown', given: '' }], year: '2020', title: 'Alpha beta gamma delta epsilon' }), 'brown2020alphabetagamma')
  check('suggestKey with no title is still legal', /^[a-z0-9-]+$/.test(suggestKey({ authors: [{ family: 'Smith', given: 'J.' }], year: '2024' })), true)
  check('suggestKey with nothing at all is a placeholder, not empty', suggestKey({}), 'untitled')
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------
{
  const show = (names) => names.map((name) => name.family + '|' + name.given).join(', ')
  check('parseAuthors: empty string', parseAuthors('').length, 0)
  check('parseAuthors: whitespace only', parseAuthors('   ').length, 0)
  check('parseAuthors: one author, family first', show(parseAuthors('Smith, J.')), 'Smith|J.')
  check('parseAuthors: semicolons separate', show(parseAuthors('Smith, J.; Jones, Alice B.')), 'Smith|J., Jones|Alice B.')
  check('parseAuthors: a comma list of Family Initials', show(parseAuthors('Smith J, Jones AB')), 'Smith|J, Jones|AB')
  check("parseAuthors: BibTeX's ` and `", show(parseAuthors('Smith, J. and Jones, Alice B.')), 'Smith|J., Jones|Alice B.')
  // Braces protect a whole name in BibTeX, so ` and ` inside them is part of the
  // name and not a separator; the family/given split inside one name is then the
  // one BibTeX itself makes (`Smith` / `J. and Sons`), which is why only the
  // COUNT is asserted here.
  check('parseAuthors: ` and ` inside braces is one name', parseAuthors('{Smith, J. and Sons}').length, 1)
  check('parseAuthors: and the braces are not part of it', parseAuthors('{Smith, J. and Sons}')[0].family, 'Smith')
  check('parseAuthors: one author with no given name', show(parseAuthors('Smith')), 'Smith|')
  check('parseAuthors: a corporate author with a trailing comma', show(parseAuthors('World Health Organization,')), 'World Health Organization|')
  check('parseAuthors: a family of several words', show(parseAuthors('van der Berg, Jan')), 'van der Berg|Jan')
  check('parseAuthors: trailing initials mean family first', show(parseAuthors('Smith J')), 'Smith|J')
  check('parseAuthors: BibTeX order when nothing is initials', show(parseAuthors('Alice B. Jones')), 'Jones|Alice B.')
  check('parseAuthors: a dangling separator makes no empty author', show(parseAuthors('Smith, J.;')), 'Smith|J.')
  check('parseAuthors: a list of four comma pairs', show(parseAuthors('Smith, J., Jones, A.')), 'Smith|J., Jones|A.')
  check('parseAuthors: initials-only given name', show(parseAuthors('Smith, A.B.')), 'Smith|A.B.')
  check('parseAuthors: anything at all is never undefined', JSON.stringify(parseAuthors('S')).includes('undefined'), false)
}

// ---------------------------------------------------------------------------
// The round-trip fixture: every kind these three formats can carry
// ---------------------------------------------------------------------------
const CORE = [
  {
    key: 'smith2024effect',
    kind: 'journal-article',
    title: 'The effect of X on Y',
    authors: [{ family: 'Smith', given: 'J.' }, { family: 'Jones', given: 'Alice B.' }],
    year: '2024',
    container: 'Journal of Studies',
    volume: '12',
    issue: '3',
    pages: '45-67',
    doi: '10.1234/abcd',
    url: 'https://example.org/a',
    issn: '1234-5678',
    note: 'A note about the article',
  },
  {
    key: 'brown2019methods',
    kind: 'book',
    title: 'Methods of enquiry',
    authors: [{ family: 'Brown', given: 'R.' }],
    year: '2019',
    edition: '2nd',
    publisher: 'Academic Press',
    place: 'London',
    isbn: '978-0-00-000000-0',
  },
  {
    key: 'chen2021chapter',
    kind: 'chapter',
    title: 'A chapter on things',
    authors: [{ family: 'Chen', given: 'L.' }],
    year: '2021',
    container: 'The Handbook of Things',
    editor: [{ family: 'Diaz', given: 'M.' }],
    pages: '101-120',
    publisher: 'Springer',
    place: 'Berlin',
    doi: '10.1007/978-3',
  },
  {
    key: 'okoro2022conference',
    kind: 'conference-paper',
    title: 'A conference paper on things',
    authors: [{ family: 'Okoro', given: 'N.' }],
    year: '2022',
    container: 'Proceedings of the Annual Meeting',
    pages: '1-9',
    doi: '10.1109/x',
  },
  {
    key: 'who2023report',
    kind: 'report',
    title: 'A technical report on things',
    authors: [{ family: 'World Health Organization', given: '' }],
    year: '2023',
    publisher: 'WHO',
    place: 'Geneva',
    url: 'https://example.org/report',
  },
  {
    key: 'lee2020web',
    kind: 'web',
    title: 'A web page on things',
    authors: [{ family: 'Lee', given: 'K.' }],
    year: '2020',
    container: 'Example Site',
    url: 'https://example.org/page',
    accessed: '2026-01-02',
  },
  {
    key: 'patel2018thesis',
    kind: 'thesis',
    title: 'A doctoral thesis on things',
    authors: [{ family: 'Patel', given: 'S.' }],
    year: '2018',
    publisher: 'University of Somewhere',
    place: 'Somewhere',
  },
]

const DATASET = {
  key: 'nasa2021dataset',
  kind: 'dataset',
  title: 'A dataset of things',
  authors: [{ family: 'NASA', given: '' }],
  year: '2021',
  publisher: 'NASA',
  url: 'https://example.org/data',
}

const PREPRINT = {
  key: 'doe2025preprint',
  kind: 'preprint',
  title: 'A preprint of things',
  authors: [{ family: 'Doe', given: 'A.' }],
  year: '2025',
  container: 'bioRxiv',
  doi: '10.1101/x',
}

/**
 * The fields a round trip must return unchanged.
 *
 * `accessed` is absent because EndNote tagged has no access-date tag at all, and
 * the comparison is one list for all three formats; RIS's `Y2` and BibTeX's
 * `urldate` carry it and are asserted on their own further down. Every other
 * field of the shape is here, including the serial numbers, whose shape is what
 * decides which of the two a shared tag meant.
 */
const COMPARED = [
  'key',
  'kind',
  'title',
  'authors',
  'year',
  'container',
  'editor',
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
  'note',
]

function fieldDiffs(expected, actual) {
  const want = normaliseRecord(expected)
  const got = normaliseRecord(actual)
  const diffs = []
  for (const field of COMPARED) {
    if (JSON.stringify(want[field]) !== JSON.stringify(got[field])) diffs.push(field)
  }
  return diffs
}

/** Report the mismatched field and both values, but only when there is one. */
function detail(expected, actual, diffs) {
  const want = normaliseRecord(expected)
  const got = normaliseRecord(actual)
  for (const field of diffs) {
    console.log('     ' + field + ': want ' + JSON.stringify(want[field]) + ' got ' + JSON.stringify(got[field]))
  }
}

function roundTrips(label, render, read, records) {
  const text = render(records)
  const back = read(text)
  check(label + ': one record out per record in', back.length, records.length)
  let clean = true
  records.forEach((record, index) => {
    const got = back[index] ?? blankRecord()
    const diffs = fieldDiffs(record, got)
    if (diffs.length > 0) detail(record, got, diffs)
    clean = check(label + ' round trip: ' + record.key, diffs.join(','), '') && clean
  })
  // A second pass must produce the same bytes: a round trip that drifts by one
  // character per pass is a bibliography that rots as it is edited.
  check(label + ' is a fixed point', render(back), text)
  return clean
}

console.log('')
roundTrips('RIS', renderRis, importRis, [...CORE, DATASET])
roundTrips('BibTeX', renderBib, importBib, [...CORE, PREPRINT])
roundTrips('EndNote', renderEnw, importEnw, [...CORE, DATASET])

// A fixed point proves the SECOND pass agrees with the first, which means a
// defect present in both passes is invisible to it. These two read the bytes a
// strict reader reads instead: the entry opener has one comma and not two (an
// empty field name is a hard error in every BibTeX implementation), and a record
// with no key at all gets one.
{
  check('BibTeX: the opener is `@type{key,`', renderBib([CORE[0]]).split('\n')[0], '@article{smith2024effect,')
  check('BibTeX: no entry holds an empty field name', /,,\s*\n/.test(renderBib([...CORE, PREPRINT, DATASET])), false)
  check('BibTeX: a keyless record is given a key on the way out', importBib(renderBib([{ kind: 'report', title: 'A keyless report' }]))[0].key, 'keylessreport')
  check('RIS: a keyless record is given a key too', importRis(renderRis([{ kind: 'report', title: 'A keyless report' }]))[0].key, 'keylessreport')
  check('EndNote: a keyless record is given a key too', importEnw(renderEnw([{ kind: 'report', title: 'A keyless report' }]))[0].key, 'keylessreport')
}

// ---------------------------------------------------------------------------
// What each format cannot carry, said out loud
// ---------------------------------------------------------------------------
{
  const risPreprint = importRis(renderRis([PREPRINT]))[0]
  check('RIS carries a preprint as an unpublished work', renderRis([PREPRINT]).includes('TY  - UNPB'), true)
  check('RIS has no preprint kind, so it reads back as an article', risPreprint.kind, 'journal-article')
  check('and the container it does carry still arrives', risPreprint.container, 'bioRxiv')

  const bibDataset = importBib(renderBib([DATASET]))[0]
  check('BibTeX has no dataset entry, so a dataset becomes @misc', renderBib([DATASET]).startsWith('@misc{'), true)
  check('and it reads back as a web page, because it has a URL', bibDataset.kind, 'web')

  check('RIS carries the access date in Y2', importRis(renderRis([CORE[5]]))[0].accessed, '2026-01-02')
  check('BibTeX carries it in urldate', importBib(renderBib([CORE[5]]))[0].accessed, '2026-01-02')
  check('EndNote tagged has no access date at all', importEnw(renderEnw([CORE[5]]))[0].accessed, '')

  const noAuthors = importRis(renderRis([{ kind: 'report', title: 'An unattributed report' }]))[0]
  check('a record with no authors round trips with none', JSON.stringify(noAuthors.authors), '[]')
  check('and it is still given a legal key', /^[a-z0-9-]+$/.test(noAuthors.key), true)
  check('a record with no year round trips with none', importEnw(renderEnw([{ kind: 'report', title: 'No year at all' }]))[0].year, '')
  check('an empty list renders nothing', renderRis([]) + renderBib([]) + renderEnw([]), '')
}

// ---------------------------------------------------------------------------
// The readers, on text a real exporter would write
// ---------------------------------------------------------------------------
{
  const risSource = [
    'TY\t- JOUR',
    'ID  - one-space-key',
    'AU  - Smith, J.',
    'AU  - Jones, Alice B.',
    'TI  - A story about quality',
    'JO  - Journal of Quality',
    'PY  - 2024/03/01',
    'VL  - 12',
    'IS  - 3',
    'SP  - 45',
    'EP  - 67',
    'DO  - https://doi.org/10.1234/abcd',
    'UR  - https://example.org/x',
    'ER  - ',
    'M1  - something in a metadata line',
    'TY  - GEN',
    'TI  - A vague thing',
    'JF  - Some Journal',
    'ER  - ',
    'TY  - GEN',
    'TI  - Another vague thing',
    'ER  - ',
    'TY  - ELEC',
    'TI  - A record whose end tag never arrived',
    'UR  - https://example.org/y',
  ].join('\r\n')
  const ris = importRis(risSource)
  check('RIS: CRLF, a tab and one-space separators all read', ris.length, 4)
  check('RIS: the key comes from ID', ris[0].key, 'one-space-key')
  check('RIS: the kind comes from TY', ris[0].kind, 'journal-article')
  check('RIS: PY takes the leading four digits', ris[0].year, '2024')
  check('RIS: SP/EP become one range', ris[0].pages, '45-67')
  check('RIS: a DOI written as a URL is stored as a DOI', ris[0].doi, '10.1234/abcd')
  check('RIS: one author per AU line', ris[0].authors.length, 2)
  check('RIS: and the second is read family-first', ris[0].authors[1].family + '|' + ris[0].authors[1].given, 'Jones|Alice B.')
  check('RIS: an unknown type WITH a journal is an article', ris[1].kind, 'journal-article')
  check('RIS: an unknown type with no container is a report', ris[2].kind, 'report')
  // Only `JO`/`JF` is evidence of an article: a `T2` book title is not, and a
  // record that has one and no journal is still not an article.
  check(
    'RIS: an unknown type with only a book title is still a report',
    importRis('TY  - GEN\nTI  - A thing\nT2  - A Book\nER  - ')[0].kind,
    'report',
  )
  check('RIS: an unterminated last record is still read', ris[3].title, 'A record whose end tag never arrived')
  check('RIS: a line after ER belongs to no record', JSON.stringify(ris).includes('metadata line'), false)
  check('RIS: empty input is an empty list', importRis('').length, 0)
  check('RIS: content before the first TY is ignored', importRis('JUNK\nAU  - Smith, J.\nER  - ').length, 0)
  check('RIS: text that is not RIS is an empty list, not a crash', importRis('hello world').length, 0)
}

{
  const bibSource = [
    'Some prose before the first entry, which is not an entry.',
    '@string{jt = "Journal of Things"}',
    '',
    '@article{smith2024effect,',
    '  author = {Smith, J. and Jones, Alice B.},',
    '  title = {The {NASA} study of {\\"u}mlauts},',
    '  journal = jt,',
    '  year = 2024,',
    '  volume = {12},',
    '  number = {3},',
    '  pages = {45--67},',
    '  doi = {10.1234/abcd},',
    '  url = "https://example.org/x",',
    '  note = {A note with an \\& ampersand},',
    '}',
    '',
    '@book(brown2019methods,',
    '  author = {Brown, R.},',
    '  title = {Methods of enquiry},',
    '  publisher = {Academic Press},',
    '  address = {London},',
    '  year = {2019}',
    ')',
    '',
    '@inbook{chen2021chapter,',
    '  author = {Chen, L.},',
    '  title = {A chapter on things},',
    '  booktitle = {The Handbook of Things},',
    '  pages = {101--120},',
    '  year = {2021}',
    '}',
    '',
    '@misc{lee2020web,',
    '  author = {Lee, K.},',
    '  title = {A web page on things},',
    '  url = {https://example.org/page},',
    '  year = {2020}',
    '}',
    '',
    '@misc{who2023report,',
    '  author = {World Health Organization,},',
    '  title = {A technical report on things},',
    '  howpublished = {Technical report},',
    '  year = {2023}',
    '}',
    '',
    '@unpublished{doe2025preprint,',
    '  author = {Doe, A.},',
    '  title = {A preprint of things},',
    '  year = {2025}',
    '}',
    '',
    '@mastersthesis{patel2018thesis,',
    '  author = {Patel, S.},',
    '  title = {A masters thesis on things},',
    '  school = {University of Somewhere},',
    '  year = {2018}',
    '}',
  ].join('\n')
  const bib = importBib(bibSource)
  check('BibTeX: @string is not a record', bib.length, 7)
  check('BibTeX: the entry key is kept', bib[0].key, 'smith2024effect')
  check('BibTeX: nested braces are matched, not cut', bib[0].title, 'The NASA study of ümlauts')
  check('BibTeX: an escaped character is unescaped', bib[0].note, 'A note with an & ampersand')
  check('BibTeX: two fields, one entry', bib[0].volume + '/' + bib[0].issue, '12/3')
  check('BibTeX: a page range is one range', bib[0].pages, '45-67')
  check('BibTeX: a quoted value reads the same as a braced one', bib[0].url, 'https://example.org/x')
  check('BibTeX: ` and ` splits the author list', bib[0].authors.length, 2)
  check('BibTeX: an @string macro name is kept, not guessed at', bib[0].container, 'jt')
  check('BibTeX: a parenthesised entry is an entry', bib[1].key, 'brown2019methods')
  check('BibTeX: @inbook is a chapter', bib[2].kind, 'chapter')
  check('BibTeX: booktitle is the container', bib[2].container, 'The Handbook of Things')
  check('BibTeX: @misc with a URL is a web page', bib[3].kind, 'web')
  check('BibTeX: @misc with howpublished is a report', bib[4].kind, 'report')
  check('BibTeX: @unpublished is a preprint', bib[5].kind, 'preprint')
  check('BibTeX: @mastersthesis is a thesis', bib[6].kind, 'thesis')
  check('BibTeX: school is the publisher of a thesis', bib[6].publisher, 'University of Somewhere')
  check('BibTeX: a corporate author keeps its family', bib[4].authors[0].family, 'World Health Organization')
  check('BibTeX: empty input is an empty list', importBib('').length, 0)
  check('BibTeX: an unterminated entry is skipped, not guessed', importBib('@article{x,\n title = {A title}').length, 0)
}

{
  const nbibSource = [
    'PMID- 12345678',
    'OWN - NLM',
    'TI  - A story about quality in higher education that runs long and wraps across',
    '      two lines of the file',
    'AU  - Smith J',
    'AU  - Jones AB',
    'JT  - Journal of Quality',
    'TA  - J Qual',
    'DP  - 2024 Mar 3',
    'VI  - 12',
    'IP  - 3',
    'PG  - 45-67',
    'AB  - An abstract of the article.',
    'LA  - eng',
    'LID - 10.1234/abcd [doi]',
    'AID - S0000-0000(24)00001-2 [pii]',
    '',
    'PMID- 87654321',
    'TI  - A second article',
    'AU  - Brown R',
    'JT  - Another Journal',
    'DP  - 2019',
    'PG  - 1-9',
  ].join('\n')
  const nbib = importNbib(nbibSource)
  check('MEDLINE: a blank line separates two records', nbib.length, 2)
  check('MEDLINE: a wrapped title is joined with one space', nbib[0].title, 'A story about quality in higher education that runs long and wraps across two lines of the file')
  check('MEDLINE: JT is the container', nbib[0].container, 'Journal of Quality')
  check('MEDLINE: every record is a journal article', nbib[0].kind + nbib[1].kind, 'journal-articlejournal-article')
  check('MEDLINE: DP takes the leading four digits', nbib[0].year, '2024')
  check('MEDLINE: PG is one range', nbib[0].pages, '45-67')
  check('MEDLINE: one name per AU line, family first', nbib[0].authors[0].family + '|' + nbib[0].authors[0].given, 'Smith|J')
  check('MEDLINE: LID [doi] is the DOI', nbib[0].doi, '10.1234/abcd')
  check('MEDLINE: an AID that is not a [doi] is not the DOI', nbib[0].doi.includes('pii'), false)
  check('MEDLINE: the abstract has somewhere to go', nbib[0].note.includes('An abstract of the article.'), true)
  check('MEDLINE: a tag with no field in this shape is dropped, not invented', JSON.stringify(nbib).includes('eng'), false)
  check('MEDLINE: every record gets a suggested key', /^[a-z0-9-]+$/.test(nbib[0].key), true)
  check('MEDLINE: empty input is an empty list', importNbib('').length, 0)
}

{
  const enwSource = [
    '%0 Journal Article',
    '%F smith2024effect',
    '%A Smith, J.',
    '%A Jones, Alice B.',
    '%T The effect of X on Y',
    '%J Journal of Studies',
    '%V 12',
    '%N 3',
    '%P 45-67',
    '%D 2024',
    '%@ 1234-5678',
    '%R 10.1234/abcd',
    '%U https://example.org/a',
    '%Z A note about the article',
    '%X An abstract, which is a second note',
    '%8 2024/03/01',
    '',
    '%0 Book Section',
    '%A Chen, L.',
    '%E Diaz, M.',
    '%T A chapter on things',
    '%B The Handbook of Things',
    '%P 101-120',
    '%D 2021',
    '%I Springer',
    '%C Berlin',
    '',
    '%0 Dataset',
    '%T A dataset of things',
    '%A NASA,',
    '%U https://example.org/data',
    '',
    '%0 Something Else Entirely',
    '%T An unfamiliar type with a container',
    '%J Some Journal',
    '',
    '%0 Something Else Entirely',
    '%T An unfamiliar type with no container',
  ].join('\n')
  const enw = importEnw(enwSource)
  check('EndNote: %0 opens each record', enw.length, 5)
  check('EndNote: the key comes from %F', enw[0].key, 'smith2024effect')
  check('EndNote: an ISSN-shaped %@ is an ISSN', enw[0].issn, '1234-5678')
  check('EndNote: %Z and %X are both kept', enw[0].note.includes('A note about the article') && enw[0].note.includes('An abstract'), true)
  check('EndNote: Book Section is a chapter', enw[1].kind, 'chapter')
  check('EndNote: %B is the container of a section', enw[1].container, 'The Handbook of Things')
  check('EndNote: %E is an editor', enw[1].editor[0].family, 'Diaz')
  check('EndNote: %I and %C are publisher and place', enw[1].publisher + '/' + enw[1].place, 'Springer/Berlin')
  check('EndNote: Dataset is a dataset', enw[2].kind, 'dataset')
  check('EndNote: a corporate author keeps its family', enw[2].authors[0].family, 'NASA')
  check('EndNote: an unknown type with a container is an article', enw[3].kind, 'journal-article')
  check('EndNote: an unknown type with no container is a report', enw[4].kind, 'report')
  check('EndNote: empty input is an empty list', importEnw('').length, 0)
  const wrapped = importEnw('%0 Book\n%T A title that the exporter\nwrapped onto a second line\n')
  check('EndNote: a line with no %tag continues the one above', wrapped[0].title, 'A title that the exporter wrapped onto a second line')
}

// ---------------------------------------------------------------------------
// Sniffing, dispatch and refusal
// ---------------------------------------------------------------------------
{
  check('an empty string is nothing to read', JSON.stringify(importCitations('')), '[]')
  check('whitespace is nothing to read', JSON.stringify(importCitations('  \n\t ')), '[]')
  check('sniffing names RIS', sniffFormat('TY  - JOUR\nER  - '), 'ris')
  check('sniffing names BibTeX', sniffFormat('@article{x, title = {y}}'), 'bibtex')
  check('sniffing names MEDLINE', sniffFormat('PMID- 1\nTI  - x'), 'nbib')
  check('sniffing names EndNote', sniffFormat('%0 Journal Article\n%T x'), 'enw')
  check('sniffing refuses to guess', sniffFormat('a poem about citations'), null)

  check('a poem is REFS_FORMAT', codeOf(() => importCitations('a poem about citations')), 'REFS_FORMAT')
  check(
    'and the refusal names what it expected',
    ['RIS', 'BibTeX', 'MEDLINE', 'EndNote'].every((name) => messageOf(() => importCitations('a poem')).includes(name)),
    true,
  )
  check(
    'and it names what it DID recognise',
    messageOf(() => importCitations('AU  - Smith, J.\nTI  - A title with no TY')).includes('RIS-shaped'),
    true,
  )
  check('JSON is refused and called JSON', messageOf(() => importCitations('{"title":"x"}')).includes('JSON'), true)
  check('a refusal is a ResearchError with a code', codeOf(() => importCitations('# not a citation file')), 'REFS_FORMAT')

  const report = importCitationsReport(renderRis(CORE))
  check('the report names the format it read', report.format, 'ris')
  check('and carries the records', report.records.length, CORE.length)
  check('and nothing was dropped', report.dropped.length, 0)
  check('dispatch reads what each writer wrote', [
    importCitations(renderRis(CORE)).length,
    importCitations(renderBib(CORE)).length,
    importCitations(renderEnw(CORE)).length,
  ].join(','), CORE.length + ',' + CORE.length + ',' + CORE.length)
}

// ---------------------------------------------------------------------------
// The one rejection: a record nothing can cite
// ---------------------------------------------------------------------------
{
  const source = [
    'TY  - JOUR',
    'AU  - Smith, J.',
    'ER  - ',
    'TY  - JOUR',
    'ID  - good-one',
    'TI  - A citable record',
    'ER  - ',
  ].join('\n')
  const report = importCitationsReport(source)
  check('a record with no title and no container is dropped', report.records.length, 1)
  check('and the drop is reported', report.dropped.length, 1)
  check('with the rule it broke', report.dropped[0].reason.includes('no title and no container'), true)
  check('the citable record beside it survives', report.records[0].key, 'good-one')
  check('importCitations returns records, not the report', importCitations(source).length, 1)

  const enwDrop = importCitationsReport('%0 Book\n%A Nobody\n\n%0 Book\n%T Kept\n')
  check('the same rule holds for EndNote tagged', enwDrop.dropped.length + '/' + enwDrop.records.length, '1/1')
  const bibDrop = importCitationsReport('@book{empty}\n\n@book{kept, title = {A title}}')
  check('and for BibTeX', bibDrop.dropped.length + '/' + bibDrop.records.length, '1/1')
  const nbibDrop = importCitationsReport('PMID- 1\nAU  - Smith J\n\nPMID- 2\nTI  - Kept\n')
  check('and for MEDLINE', nbibDrop.dropped.length + '/' + nbibDrop.records.length, '1/1')
}

// ---------------------------------------------------------------------------
// Every record has every field, from every reader
// ---------------------------------------------------------------------------
{
  const sources = {
    ris: importRis(renderRis(CORE)),
    bibtex: importBib(renderBib(CORE)),
    nbib: importNbib('PMID- 1\nTI  - A title\nAU  - Smith J\n'),
    enw: importEnw(renderEnw(CORE)),
  }
  for (const [name, records] of Object.entries(sources)) {
    check(name + ': every record carries exactly the record keys', records.every((one) => Object.keys(one).join(',') === RECORD_KEYS), true)
    check(name + ': no record holds an undefined value', JSON.stringify(records).includes('undefined'), false)
    check(name + ': authors is always an array', records.every((one) => Array.isArray(one.authors) && Array.isArray(one.editor)), true)
  }
}

// ---------------------------------------------------------------------------
// The module's own contract: pure text functions, no clock, no process
// ---------------------------------------------------------------------------
{
  const source = readFileSync(refsPath, 'utf8')
  for (const [label, pattern] of [
    ['no number that changes by itself', /Math\.random/],
    ['no clock', /\bnew Date\b|Date\.now/],
    ['no process or environment read', /\bprocess\./],
    ['no child process', /child_process/],
    ['no filesystem', /node:fs/],
    ['no socket', /node:(http|https|net|tls|dgram)/],
    ['no dynamic import', /\bimport\s*\(/],
    ['no require', /\brequire\s*\(/],
  ]) {
    check('the engine has ' + label, pattern.test(source), false)
  }
  check('and it imports only the refusal it throws', (source.match(/^import .*$/gm) ?? []).join('|'), "import { ResearchError } from './run.js'")
}

console.log('')
console.log(failures === 0 ? 'all research-refs checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
