// check-media-examples.mjs - every example a MEDIA or PDF skill tells the agent
// to run must be a well-formed tool call, and (where this host can run one) it
// must actually RUN.
//
// Why this exists: `check-skill-examples.mjs` beside it does this job for the
// diagram skills - it parses or compiles every fenced example with the plugin's
// own engine. The media and PDF skills had no such guard, and the one that
// looked like it did (`check-media-node.mjs`'s "every ```json example parses"
// loop) iterated an EMPTY list: not one example in either skill is fenced
// `json`, so it passed over nothing for as long as it existed. The
// `["-i", ...]` arrays an agent is expected to copy into `media_run` were
// therefore unverified - a stray comma, a dropped quote or a renamed flag in
// them is exactly the refusal the skill was written to prevent.
//
// TWO TIERS, because the two families can promise different things:
//
//   1. SHAPE (always, hermetic). Every example line is extracted, its JSON
//      value reconstructed across as many lines as it spans, and parsed. A
//      `pdf_scan { "path": ... }` pseudo-call is parsed as the object inside it.
//      This is what catches the rot: it needs no ffmpeg, no PDF and no network.
//
//   2. EXECUTION (only when this host HAS ffmpeg, and skipped loudly when it
//      does not). A fixture set is built with real ffmpeg under the very names
//      the documents use (`clip.mp4`, `two.mkv`, `withsubs.mkv`, `a.mp4`, ...),
//      and every media example whose inputs are all fixtures is run for real, in
//      a directory of its own, through the SAME argv shape `media_run` builds -
//      `-hide_banner -loglevel warning -nostdin`, and `-y` where the tool puts
//      `-n`, because here nothing is precious and an example that writes a name
//      the fixture set already provides must still run. Overwrite policy itself
//      is pinned by `check-media-node.mjs`, not here.
//
// It is honest about what it cannot run, and it NAMES it: an example whose input
// is not in the fixture set (a document can outrun the fixtures - `hdr.mp4` and
// `interlaced.mp4` used to be examples of exactly that, and are fixtures now), one
// that needs an encoder or a filter THIS build does not have, and one marked
// `no-check` are each reported as a skip with its reason, never counted as a
// pass. That list is
// the point as much as the green lines are: it is the readable measure of how
// much of the documentation has actually been executed on this host. The build's
// own `-encoders` and `-filters` are what decide, because a static Windows
// build, a distribution Linux build and a Homebrew build genuinely disagree -
// which is the difference a portable document has to survive.
//
// The PDF family is SHAPE-only here on purpose: driving those tools needs real
// PDFs, and `check-pdf-node.mjs` already builds its own and drives all five.
//
// Run:  node scripts/checks/check-media-examples.mjs
export {} // (ESM for the dynamic imports below)

const { promises: fsp, existsSync, readFileSync, copyFileSync } = await import('node:fs')
const { spawnSync } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const roots = [
  { family: 'media', dir: path.join(repo, 'packages/dsh-media/skills') },
  { family: 'pdf', dir: path.join(repo, 'packages/dsh-pdf/skills') },
]

let failures = 0
let checked = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  checked += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
function skip(label, why) {
  skipped += 1
  console.log('skip ' + label.padEnd(58) + ' (' + why + ')')
}

// ---------------------------------------------------------------------------
// Reading the documents
// ---------------------------------------------------------------------------

/** Every markdown document under the skills roots, with its skill folder. */
async function skillDocs() {
  const found = []
  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    for (const skill of await fsp.readdir(root.dir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue
      const walk = async (dir) => {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else if (entry.name.endsWith('.md')) found.push({ family: root.family, skill: skill.name, file: full })
        }
      }
      await walk(path.join(root.dir, skill.name))
    }
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/**
 * The fenced blocks of one markdown file.
 *
 * A block is skipped when `no-check` appears in its info string or on the line
 * above the opening fence - the same convention `check-skill-examples.mjs`
 * uses, so an example that exists to show a failure stays honest without
 * failing the run.
 *
 * @param text - the file's contents.
 * @returns `{ body, line, skip }[]`.
 */
function fences(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let open = null
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*```([A-Za-z0-9_+-]*)\s*(.*)$/.exec(lines[index])
    if (!match) {
      if (open) open.body.push(lines[index])
      continue
    }
    if (open === null) {
      open = {
        lang: match[1].toLowerCase(),
        info: match[2],
        line: index + 1,
        body: [],
        skip: /no-check/i.test(match[2]) || /no-check/i.test(lines[index - 1] ?? ''),
      }
    } else {
      blocks.push(open)
      open = null
    }
  }
  return blocks
}

/** The tools whose pseudo-call shape a document may write: `pdf_scan { ... }`. */
const TOOL_NAMES = new Set([
  'media_run',
  'media_probe',
  'media_frames',
  'pdf_info',
  'pdf_read',
  'pdf_find',
  'pdf_render',
  'pdf_scan',
])

/**
 * Does this line START an example, and with what?
 *
 * Two shapes are examples: a bare JSON value (`[...]` for a `media_run` args
 * array, `{...}` for a whole call), and a `tool { ... }` pseudo-call. Anything
 * else in a fenced block is a sample of OUTPUT (`Stream mapping:`,
 * `width=640`, `NO TEXT LAYER`) or a path, and is left alone.
 *
 * @param line - one line of a fenced block.
 * @returns `{ tool: string | null, rest: string } | null`.
 */
function exampleStart(line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return { tool: null, rest: trimmed }
  const call = /^([a-z][a-z0-9_]*)\s+(\{.*)$/.exec(trimmed)
  if (call !== null && TOOL_NAMES.has(call[1])) return { tool: call[1], rest: call[2] }
  return null
}

/**
 * The bracket depth of a fragment, counting nothing inside a JSON string.
 *
 * This is what lets an example span lines (the ffprobe invocation is a two-line
 * object) without guessing where it ends: depth 0 means the value is complete.
 *
 * @param text - the fragment so far.
 * @returns the depth; `0` when the value is closed.
 */
function depthOf(text) {
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return depth
}

/** The same fragment with a trailing `// comment` (outside a string) removed. */
function stripComment(text) {
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '/' && text[index + 1] === '/') return text.slice(0, index)
  }
  return text
}

/**
 * Every example in one document.
 *
 * @param doc - `{ family, skill, file }`.
 * @returns `{ doc, line, skip, tool, value, error, raw }[]`.
 */
function examplesOf(doc) {
  const found = []
  for (const block of fences(readFileSync(doc.file, 'utf8'))) {
    // The INFO STRING declares what a block is, which is the convention every
    // bundled skill already follows: an EXAMPLE sits in a bare fence, and a
    // fence that names a language is a sample of output or a template. Without
    // this, a quoted ffmpeg log that happens to start with `[Parsed_...]` reads
    // as a JSON array.
    if (block.lang !== '' && block.lang !== 'json' && block.lang !== 'json5') continue
    let index = 0
    while (index < block.body.length) {
      const start = exampleStart(block.body[index])
      if (start === null) {
        index += 1
        continue
      }
      const first = index
      let buffer = start.rest
      let depth = depthOf(buffer)
      while (depth > 0 && index + 1 < block.body.length) {
        index += 1
        buffer += '\n' + block.body[index]
        depth = depthOf(buffer)
      }
      let value = null
      let error = null
      try {
        value = JSON.parse(buffer)
      } catch (primary) {
        // A pseudo-call may carry an explanatory `// comment` after its object;
        // strip it and try once more before calling the example broken.
        try {
          value = JSON.parse(stripComment(buffer))
        } catch (secondary) {
          error = String(secondary.message ?? primary.message)
        }
      }
      found.push({
        doc,
        line: block.line + 1 + first,
        skip: block.skip,
        tool: start.tool,
        value,
        error,
        raw: buffer.split('\n')[0],
      })
      index += 1
    }
  }
  return found
}

const docs = await skillDocs()
const examples = docs.flatMap((doc) => examplesOf(doc))
console.log('checking ' + examples.length + ' example(s) in ' + docs.length + ' skill document(s)')
console.log('')

// ---------------------------------------------------------------------------
// 1. Shape: every example is a well-formed tool call
// ---------------------------------------------------------------------------
for (const doc of docs) {
  const mine = examples.filter((example) => example.doc.file === doc.file)
  if (mine.length === 0) continue
  console.log('--- ' + path.relative(repo, doc.file) + ': ' + mine.length + ' example(s)')
  for (const example of mine) {
    const where = path.relative(repo, doc.file) + ':' + example.line
    if (example.skip) {
      skip(where, 'marked no-check')
      continue
    }
    // A pseudo-call must belong to the family it sits in: a `pdf_*` example in
    // a media skill is a document that would send the agent to a tool this
    // package does not have.
    const foreign = example.tool !== null && example.tool.startsWith('pdf_') !== (doc.family === 'pdf')
    if (!check(where, example.error === null && !foreign)) {
      if (foreign) console.log('     ' + example.tool + ' does not belong to the ' + doc.family + ' family')
      else console.log('     ' + example.raw + '\n     ' + example.error)
    }
  }
}
console.log('')

// ---------------------------------------------------------------------------
// 2. Execution: the media examples, against fixtures built under the names the
//    documents use
// ---------------------------------------------------------------------------
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-media-examples-'))
const fixtures = path.join(root, 'fixtures')
await fsp.mkdir(fixtures, { recursive: true })
process.env.DSH_HOME = path.join(root, 'dsh-home')
// A check never downloads a 170 MB binary: an absent ffmpeg is a loud skip.
process.env.DSH_MEDIA_NO_INSTALL = '1'

const media = await import(pathToFileURL(path.join(repo, 'packages/dsh-media/lib/ffmpeg.js')).href)
const home = process.env.DSH_HOME
const ffmpegAnswer = await media.ensureBinary('ffmpeg', { home, env: process.env, install: false })
const ffprobeAnswer = await media.ensureBinary('ffprobe', { home, env: process.env, install: false })

/** The binaries this host actually has, by the name `media_run` uses. */
const binaries = new Map()
if (ffmpegAnswer.ok) binaries.set('ffmpeg', ffmpegAnswer.file)
if (ffprobeAnswer.ok) binaries.set('ffprobe', ffprobeAnswer.file)

if (!binaries.has('ffmpeg')) {
  skip('every media example is EXECUTED', 'no ffmpeg on this host and the check never downloads one')
  console.log('')
  console.log('summary: shape-checked ' + examples.length + ' example(s), nothing executed (the execution tier wants ffmpeg; skipped ' + skipped + ')')
  await fsp.rm(root, { recursive: true, force: true })
  process.exitCode = failures === 0 ? 0 : 1
} else {
  const ffmpeg = binaries.get('ffmpeg')
  const run = (args, cwd = fixtures) =>
    spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    })

  /** The last `count` non-empty lines of a failed command, for the report. */
  const lastLines = (answer, count) =>
    String(answer.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-count)
      .join(' / ')
      .slice(0, 240)

  /** The names a build list prints: `-encoders` and `-filters` differ in flags only. */
  const namesFrom = (flag) => {
    const names = new Set()
    const answer = spawnSync(ffmpeg, ['-hide_banner', flag], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    for (const line of String(answer.stdout ?? '').split('\n')) {
      const match = /^\s*[A-Z.]{3,6}\s+(\S+)/.exec(line)
      if (match !== null && match[1] !== '=') names.add(match[1])
    }
    return names
  }
  const encoders = namesFrom('-encoders')
  const filterNames = namesFrom('-filters')
  console.log('this build: ' + encoders.size + ' encoder(s), ' + filterNames.size + ' filter(s)')
  console.log('')

  // The fixtures, under the exact names the documents read. Each one is
  // best-effort: a fixture this build cannot make is reported, and the examples
  // that need it are skipped BY NAME rather than quietly passed.
  const haveFixture = new Set()
  const fixture = (name, args) => {
    const answer = run(args)
    if (answer.status === 0) {
      haveFixture.add(name)
      check('fixture ' + name, true)
    } else {
      skip('fixture ' + name, lastLines(answer, 1))
    }
  }

  fixture('clip.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', 'clip.mp4',
  ])
  fixture('clip.mkv', ['-i', 'clip.mp4', '-c', 'copy', 'clip.mkv'])
  fixture('long.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=32',
    '-c:v', 'libx264', '-crf', '35', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', 'long.mp4',
  ])
  fixture('clip.avi', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=3', '-c:v', 'mpeg4', '-q:v', '8', 'clip.avi'])
  fixture('a.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'a.mp4',
  ])
  fixture('b.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'b.mp4',
  ])
  fixture('two.mkv', [
    '-i', 'clip.mp4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
    '-map', '0:v:0', '-map', '0:a:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=spa', 'two.mkv',
  ])
  await fsp.writeFile(path.join(fixtures, 'subs.srt'), '1\n00:00:00,000 --> 00:00:02,000\nhello from the fixture\n\n')
  haveFixture.add('subs.srt')
  fixture('withsubs.mkv', ['-i', 'clip.mp4', '-i', 'subs.srt', '-map', '0', '-map', '1:0', '-c', 'copy', '-c:s', 'srt', 'withsubs.mkv'])
  await fsp.writeFile(path.join(fixtures, 'notes.txt'), 'an attachment the fixture set carries\n')
  fixture('attached.mkv', ['-i', 'clip.mp4', '-c', 'copy', '-attach', 'notes.txt', '-metadata:s:t:0', 'mimetype=text/plain', 'attached.mkv'])
  fixture('pal.png', ['-i', 'clip.mp4', '-vf', 'fps=12,scale=320:-1:flags=lanczos,palettegen', 'pal.png'])
  await fsp.writeFile(path.join(fixtures, 'list.txt'), "file 'a.mp4'\nfile 'b.mp4'\n")
  haveFixture.add('list.txt')
  fixture('rotated.mp4', ['-i', 'clip.mp4', '-c', 'copy', '-metadata:s:v:0', 'rotate=90', 'rotated.mp4'])
  // `-flags +ilme+ildct` is what makes x264 signal a truly interlaced stream:
  // measured, the result probes as `field_order=tt`, where a tinterlace filter
  // alone still wrote `progressive` in the bitstream.
  fixture('interlaced.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1',
    '-flags', '+ilme+ildct', '-c:v', 'libx264', '-crf', '35', '-pix_fmt', 'yuv420p', '-an', 'interlaced.mp4',
  ])
  // Both fail loudly and are skipped by name on a build without the encoder or
  // the filter, which is the point of building fixtures best-effort.
  fixture('hdr.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1',
    '-c:v', 'libx265', '-crf', '35', '-pix_fmt', 'yuv420p10le',
    '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-an', 'hdr.mp4',
  ])
  // A transport stream, so `-show_programs` has a program to report: on an MP4
  // that section is empty, which makes the example prove nothing.
  fixture('clip.ts', ['-i', 'clip.mp4', '-c', 'copy', '-f', 'mpegts', 'clip.ts'])
  // Variable rate on purpose - dropping every third frame without duplicating
  // any - so `avg_frame_rate` (frames / duration) and `r_frame_rate` disagree,
  // which is the measurement `fields.md` documents. `-fps_mode` needs ffmpeg
  // 5.1+, and an older build skips the fixture loudly rather than failing.
  fixture('vfr.mp4', ['-i', 'clip.mp4', '-vf', "select='not(mod(n,3))'", '-fps_mode', 'vfr', '-an', 'vfr.mp4'])
  console.log('')

  // ---- what an example needs, read out of its own argv --------------------

  /**
   * Every file the argv READS.
   *
   * ffmpeg names its inputs with `-i` (and a `lavfi` graph is not a path at
   * all); ffprobe takes a bare positional path with no `-i`, so there every
   * non-option token that is not the value of a value-taking option is an input.
   */
  function inputsOf(args, binary) {
    const found = []
    if (binary === 'ffprobe') {
      const takesValue = new Set([
        '-v', '-loglevel', '-print_format', '-of', '-show_entries', '-select_streams',
        '-read_intervals', '-f', '-i', '-skip_frame', '-sections',
      ])
      for (let index = 0; index < args.length; index += 1) {
        const token = String(args[index])
        if (token.startsWith('-')) {
          if (takesValue.has(token)) index += 1
          continue
        }
        found.push(token)
      }
      return found
    }
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '-i') continue
      const value = String(args[index + 1] ?? '')
      if (String(args[index - 1] ?? '') === 'lavfi') continue
      if (value.length === 0 || value.includes('=')) continue
      found.push(value)
    }
    return found
  }

  /** The encoders the argv names, `copy` excluded - it is a codec name, not a build. */
  function encodersOf(args) {
    const found = []
    for (let index = 0; index < args.length; index += 1) {
      if (!/^-c(:[vas])?(:[0-9]+)?$/.test(args[index]) && !/^-(vcodec|acodec)$/.test(args[index])) continue
      const name = String(args[index + 1] ?? '')
      if (name.length > 0 && name !== 'copy') found.push(name)
    }
    return found
  }

  /** The filters the argv names, in `-vf`, `-af`, `-filter_complex` and `-lavfi`. */
  function filtersOf(args) {
    const found = new Set()
    const take = (value) => {
      for (const part of String(value).split(/[;,]/)) {
        const token = part.replace(/^\[[^\]]*\]/g, '').trim()
        const match = /^([a-z][a-z0-9_]*)/.exec(token)
        if (match !== null) found.add(match[1])
      }
    }
    for (let index = 0; index < args.length; index += 1) {
      if (['-vf', '-af', '-filter_complex', '-lavfi', '-filter:v', '-filter:a'].includes(args[index])) take(args[index + 1])
    }
    return [...found]
  }

  // ---- run every media example whose inputs this host can provide ---------
  const runnable = examples.filter((example) => example.doc.family === 'media' && !example.skip && example.value !== null)
  const shapeOnly = examples.filter((example) => example.doc.family === 'pdf').length
  let executed = 0
  for (const example of runnable) {
    const where = path.relative(repo, example.doc.file) + ':' + example.line
    const call = Array.isArray(example.value) ? { binary: null, args: example.value } : example.value
    if (call === null || !Array.isArray(call.args)) {
      skip(where, 'not a media_run call (no args array)')
      continue
    }
    // A bare array in the ffprobe skill is an ffprobe argv; in the ffmpeg skill
    // it is ffmpeg's. An explicit `binary` wins over both.
    const binary = call.binary ?? (example.doc.skill === 'ffprobe-cli' ? 'ffprobe' : 'ffmpeg')
    if (!binaries.has(binary)) {
      skip(where, 'no ' + binary + ' on this host')
      continue
    }
    const unknown = inputsOf(call.args, binary).filter((name) => !haveFixture.has(name))
    if (unknown.length > 0) {
      skip(where, 'no fixture named ' + unknown.join(', '))
      continue
    }
    const absentEncoder = encodersOf(call.args).find((name) => !encoders.has(name))
    if (absentEncoder !== undefined) {
      skip(where, 'this build has no encoder ' + absentEncoder)
      continue
    }
    const absentFilter = filtersOf(call.args).find((name) => !filterNames.has(name))
    if (absentFilter !== undefined) {
      skip(where, 'this build has no filter ' + absentFilter)
      continue
    }

    // Each example gets a directory of its own holding just the files it reads,
    // because `-y` is in play and the documents write names like `clip.mp4` that
    // are also fixture names. A fixture the argv only MENTIONS counts as read: a
    // path inside a filter value (`subtitles=subs.srt`) never follows an `-i`.
    const dir = path.join(root, 'runs', String(executed))
    await fsp.mkdir(dir, { recursive: true })
    const joined = call.args.join(' ')
    const files = new Set(inputsOf(call.args, binary))
    for (const name of haveFixture) if (joined.includes(name)) files.add(name)
    if (files.has('list.txt')) {
      files.add('a.mp4')
      files.add('b.mp4')
    }
    for (const name of files) copyFileSync(path.join(fixtures, name), path.join(dir, name))

    const argv = binary === 'ffmpeg'
      ? ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', ...call.args]
      : call.args
    const answer = spawnSync(binaries.get(binary), argv, { cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    executed += 1
    if (!check(where + ' runs', answer.status === 0)) {
      console.log('     ' + binary + ' ' + argv.join(' '))
      console.log('     ' + lastLines(answer, 3))
    }
  }

  console.log('')
  console.log(
    'summary: shape-checked ' + examples.length + ' example(s), executed ' + executed +
      ', skipped ' + skipped + ' (' + shapeOnly + ' PDF example(s) are shape-only, and every other skip names its reason above)',
  )
  await fsp.rm(root, { recursive: true, force: true })
  process.exitCode = failures === 0 ? 0 : 1
}
