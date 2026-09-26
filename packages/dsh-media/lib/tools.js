/**
 * dsh-media — the three tools the agent actually calls.
 *
 *   - `media_probe`  what a media file IS: ffprobe's own reading of the header,
 *                    translated into a report a reader can act on, plus the
 *                    verdict "a browser can play this / needs a remux / needs a
 *                    transcode" and, when it needs work, the exact command.
 *   - `media_run`    a REAL ffmpeg or ffprobe command: an argv ARRAY, run with
 *                    a deadline and an output cap, in the conversation
 *                    workspace, refusing to overwrite an existing file unless
 *                    the caller says so.
 *   - `media_frames` frames out of a video - at the timestamps you name, or
 *                    evenly across it, or tiled into ONE contact sheet - written
 *                    as new files whose real dimensions come back in the answer.
 *
 * What they deliberately do NOT do: no shell, no string command, no implicit
 * transcoding of anything, no writing over a file that is already there, and no
 * guessing about the host's ffmpeg - every one of them resolves the binary
 * through `ffmpeg.js` and says in a sentence when the machine has none (starting
 * the pinned download in the background rather than blocking on it).
 */
import path from 'node:path'
import fsp from 'node:fs/promises'

import { ensureBinary, resolveBinaries, versionOf } from './ffmpeg.js'
import { resolveDirectory, resolveTarget } from './paths.js'
import { formatBytes, formatDuration, formatReport, probeJson, summarize } from './probe.js'
import { clampOutput, clampTimeout, runBinary } from './run.js'

/** `ffmpeg`'s own arguments that mean "overwrite" and "never overwrite". */
const OVERWRITE_FLAGS = new Set(['-y', '-n'])
/** The most frames one `media_frames` call may write. */
export const MAX_FRAMES = 24
/** The most arguments one `media_run` call may carry. */
export const MAX_ARGS = 200
/** The width ladder a frame is scaled to. */
const MIN_FRAME_WIDTH = 16
const MAX_FRAME_WIDTH = 4096

/** The session id one tool call belongs to. */
export function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session && session.id
  if (typeof id !== 'string' || id === '') throw new Error('the media tools require an owning agent session')
  return id
}

/** One argv array as a line a reader can copy and run. */
export function commandLine(binary, args) {
  const quote = (value) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : '"' + String(value).replace(/"/g, '\\"') + '"')
  return binary + ' ' + args.map(quote).join(' ')
}

/** A timestamp as seconds: `12.5`, `00:01:23`, `1:02:03.250`, or a number. */
export function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  const text = String(value ?? '').trim()
  if (text === '') return null
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  let seconds = 0
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null
    seconds = seconds * 60 + Number(part)
  }
  return seconds
}

/** A file name without its extension. */
function stemOf(file) {
  const base = path.basename(file)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/**
 * ffmpeg's quality flag for a frame. A PNG is lossless and needs none; an
 * mjpeg written without `-q:v` comes out at ffmpeg's own low default, which
 * makes a contact sheet look worse than the video it came from.
 */
function qualityFlags(extension) {
  return extension === 'jpg' ? ['-q:v', '2'] : []
}

/**
 * The pixel size of a PNG or JPEG, read from its own header - which is cheaper
 * and more honest than asking ffprobe about a file this plugin just wrote.
 *
 * @returns `{ width, height }` or null when the header is not a shape this knows.
 */
export async function imageSizeOf(file) {
  let buffer
  try {
    buffer = await fsp.readFile(file)
  } catch (err) {
    return null
  }
  if (buffer.length > 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      // SOF0..SOF15, minus the two markers that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

/** The first free name for a file this plugin is about to write. */
async function freeName(directory, name) {
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let attempt = 1; attempt < 200; attempt += 1) {
    const candidate = path.join(directory, attempt === 1 ? name : stem + '-' + attempt + extension)
    try {
      await fsp.access(candidate)
    } catch (err) {
      return candidate
    }
  }
  throw new Error('could not find a free name for ' + name + ' in ' + directory)
}

/** The view the conversation card draws for these tools. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    name: { type: 'string' },
    address: { type: 'string' },
    scope: { type: 'string', enum: ['workspace', 'absolute'] },
    bytes: { type: 'number' },
    duration: { type: 'number' },
    container: { type: 'string' },
    verdict: { type: 'string', enum: ['playable', 'image', 'remux', 'transcode', 'unknown'] },
    trailer: { type: 'string' },
    command: { type: 'string' },
    binary: { type: 'string' },
    exitCode: { type: 'number' },
    timedOut: { type: 'boolean' },
    ms: { type: 'number' },
    frames: { type: 'array', items: { type: 'string' } },
    outputs: { type: 'array', items: { type: 'string' } },
  },
  required: ['file'],
}

const PATH_SCHEMA = {
  type: 'string',
  description:
    "The media file: a path inside this conversation's workspace (relative), or an absolute path - an image, video, audio file or stream segment anywhere on this machine, a chat attachment under <DSH_HOME>/attachments/v1/files/..., or a file in Downloads.",
}

/**
 * Build the three tools.
 *
 * @param deps - `{ ctx, home, env, log }`.
 * @returns the tool definitions to register.
 */
export function buildTools(deps) {
  const log = deps.log ?? { warn() {}, info() {} }

  /** Resolve the binary a call needs, or the sentence that says why it cannot. */
  const binaryFor = async (name, options = {}) => {
    const found = await ensureBinary(name, { home: deps.home, env: deps.env, log, install: options.install })
    if (found.ok) return found
    const resolved = resolveBinaries({ home: deps.home, env: deps.env })
    const detail = []
    if (!resolved.bundled && resolved.install.state === 'unsupported') detail.push(resolved.install.message)
    return { ok: false, message: [found.message, ...detail].filter(Boolean).join('\n') }
  }

  /** Resolve a tool's path, turning a typed refusal into readable text. */
  const targetOf = async (args, exec, options = {}) => {
    try {
      return { ok: true, target: await resolveTarget(deps.ctx, { session: sessionOf(exec), path: args.path, extensions: options.extensions }) }
    } catch (err) {
      return { ok: false, text: err && err.message ? String(err.message) : String(err), file: typeof args.path === 'string' ? args.path : '' }
    }
  }

  /** The view for one resolved target. */
  const viewOf = (target, extra = {}) => ({
    file: target.file,
    name: path.basename(target.file),
    scope: target.scope,
    bytes: target.size,
    ...extra,
  })

  // -------------------------------------------------------------------------
  // media_probe
  // -------------------------------------------------------------------------
  const probe = {
    name: 'media_probe',
    description: [
      'Describe a media file before touching it: the container, its duration and bitrate, and every stream ffprobe finds - video codec, exact pixel size and display aspect, frame rate as both its rational (30000/1001) and its decimal, pixel format and bit depth, rotation; audio codec, sample rate, channel layout and bit depth; subtitles, attachments, language and title tags, and chapters with their timestamps.',
      'It ends with the one verdict a viewer needs: whether a browser plays this file as it is, needs a REMUX (the streams are browser-decodable but the container is not - `-c copy` fixes it) or needs a TRANSCODE (a codec a browser does not decode), and it prints the exact ffmpeg command that would do it.',
      'This is how to look at an image or a video at all: the read tool refuses binary files, so a PNG\'s dimensions, a video\'s codec and an audio file\'s sample rate come from here. It reads the header and decodes nothing, so it is cheap and it cannot fail on a damaged tail.',
      'Pass `raw: true` to also get ffprobe\'s own JSON, when you want a field this report does not print.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        raw: { type: 'boolean', description: "Also return ffprobe's own JSON, for a field the report omits." },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Probe ' + (args && args.path ? String(args.path) : 'a media file'), kind: 'other' }),
    presentResult: (args, result) => ({ card: 'generic', title: 'Media ' + (result.name ?? (args && args.path ? String(args.path) : '')), content: result.text }),
    async execute(args, exec) {
      const resolved = await targetOf(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const ffprobe = await binaryFor('ffprobe')
      if (!ffprobe.ok) return { text: ffprobe.message, view: viewOf(target) }
      const started = Date.now()
      const answer = await probeJson({ file: ffprobe.file, path: target.file, signal: exec.signal })
      if (!answer.ok && answer.json === null) {
        return {
          text:
            'ffprobe could not read ' +
            path.basename(target.file) +
            ': ' +
            answer.error +
            '\nThat is the file itself, not this plugin: ffprobe identified no container in it at all. media_probe reads the header, so a file it refuses has no readable header - a truncated download, a text file with the wrong extension, or a container ffmpeg does not know.',
          view: viewOf(target, { verdict: 'unknown' }),
        }
      }
      const facts = summarize({ file: target.file, name: path.basename(target.file), size: target.size, json: answer.json, path: target.file })
      const source = await versionOf(ffprobe.file, { signal: exec.signal })
      // ffmpeg's banner line carries its copyright after the version; the
      // version is the part a diagnosis needs.
      const banner = String(source.line ?? '').split(' Copyright')[0].trim()
      const lines = [formatReport(facts, { elapsedMs: Date.now() - started, source: banner || 'ffprobe' })]
      if (answer.error) lines.push('ffprobe warning: ' + answer.error)
      if (args.raw === true) {
        lines.push('')
        lines.push('ffprobe JSON:')
        lines.push(JSON.stringify(answer.json, null, 2))
      }
      return {
        text: lines.join('\n'),
        view: viewOf(target, {
          duration: facts.durationSec ?? undefined,
          container: facts.container.name || 'unknown',
          verdict: facts.playable.verdict,
          trailer: facts.playable.command || facts.playable.reason,
        }),
      }
    },
  }

  // -------------------------------------------------------------------------
  // media_run
  // -------------------------------------------------------------------------
  const run = {
    name: 'media_run',
    description: [
      'Run a real ffmpeg or ffprobe command. `args` is an ARRAY of arguments - never a command string, never a shell: `["-i","in.mkv","-c","copy","out.mp4"]`. Nothing is interpolated, so a path with a space, a filter graph and a `%` in a filename all arrive exactly as written.',
      'Two things are added for you unless you pass your own: `-nostdin` (so ffmpeg can never wait for input) and `-n` - it will NOT overwrite an existing file. Pass `overwrite: true` to allow that (it becomes `-y`), which is the only way this tool can replace something. `-hide_banner` and `-loglevel warning` are added for the same reason unless you set a log level yourself, so the answer is the diagnosis rather than the build banner.',
      'It runs in the conversation workspace by default, so relative paths mean what you expect; pass `cwd` to change that. The call has a deadline (default 120 s, at most 600 s) and the output is capped, so a runaway decode is killed and a chatty one is trimmed rather than returned whole. The answer names the exit code, the elapsed time and the files the command wrote.',
      'Use it for anything the purpose-built tools do not cover: extracting or testing a stream, converting a frame to a different image format, reading deep ffprobe fields (`["-v","error","-select_streams","v:0","-show_frames","-read_intervals","%+#1","file.mp4"]`), building a contact sheet by hand, or measuring a filter.',
      'For the common cases prefer media_probe (a report, not a command), media_frames (frames out of a video) and the video tab\'s own remux, which reuses this same binary.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['args'],
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'The arguments, one array element each - e.g. ["-i","clip.mp4","-vn","-c:a","copy","audio.m4a"]. The program itself is chosen by `binary` and must NOT be the first element.',
        },
        binary: { type: 'string', enum: ['ffmpeg', 'ffprobe'], description: 'Which program to run. Default ffmpeg.' },
        cwd: { type: 'string', description: 'Working directory: relative to the conversation workspace, or absolute. Default: the workspace itself.' },
        timeoutMs: { type: 'number', description: 'Kill the command after this many milliseconds (default 120000, maximum 600000).' },
        maxOutputChars: { type: 'number', description: 'Keep at most this much of the combined output (default 200000, maximum 1000000). The head and the tail are kept and the count dropped is named.' },
        overwrite: { type: 'boolean', description: 'Allow ffmpeg to overwrite an existing output file (adds -y). Without it, -n is added and an existing file stops the command.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => {
      const binary = args && args.binary === 'ffprobe' ? 'ffprobe' : 'ffmpeg'
      const first = args && Array.isArray(args.args) ? args.args.join(' ') : ''
      return { card: 'generic', title: binary + ' ' + (first.length > 80 ? first.slice(0, 77) + '…' : first), kind: 'other' }
    },
    presentResult: (args, result) => ({
      card: 'generic',
      title: (result.binary ?? 'ffmpeg') + ' exited ' + String(result.exitCode ?? '?'),
      content: result.text,
    }),
    async execute(args, exec) {
      const binaryName = args.binary === 'ffprobe' ? 'ffprobe' : 'ffmpeg'
      if (typeof args.args === 'string') {
        return {
          text:
            'args must be an ARRAY of arguments, not a string - this tool never parses a command line and never runs a shell. Split what you wrote on its spaces yourself and pass it as elements, e.g. ["-i","clip.mp4","-c","copy","out.mp4"].',
          view: { file: '' },
        }
      }
      if (!Array.isArray(args.args) || args.args.length === 0) {
        return { text: 'args must be a non-empty array of arguments, e.g. ["-i","clip.mp4","-c","copy","out.mp4"].', view: { file: '' } }
      }
      if (args.args.length > MAX_ARGS) {
        return { text: 'That is ' + args.args.length + ' arguments; this tool runs at most ' + MAX_ARGS + '. A filter graph that long belongs in a file you pass with -filter_complex_script.', view: { file: '' } }
      }
      const bad = args.args.find((entry) => typeof entry !== 'string' || entry.includes('\u0000'))
      if (bad !== undefined) {
        return { text: 'Every element of args must be a string without a NUL byte; element ' + (args.args.indexOf(bad) + 1) + ' is not.', view: { file: '' } }
      }
      // The working directory is the workspace unless the caller names one, and
      // it is resolved with the same policy a file is.
      let cwd
      try {
        cwd = (await resolveDirectory(deps.ctx, { session: sessionOf(exec), path: typeof args.cwd === 'string' ? args.cwd : '', label: 'working directory' })).directory
      } catch (err) {
        return { text: 'That working directory cannot be used: ' + (err && err.message ? String(err.message) : String(err)), view: { file: '' } }
      }
      const binary = await binaryFor(binaryName)
      if (!binary.ok) return { text: binary.message, view: { file: '' } }

      // ffmpeg's own overwrite flag is the caller's to decide and this plugin's
      // to keep honest: `-n` unless they asked for `-y`, and never both. The
      // injected flags go FIRST: a flag appended after the output file is still
      // parsed, but a caller reading the answer sees a command line that looks
      // like a mistake, and ffprobe has no `-n` at all - so only ffmpeg gets
      // any of these.
      const supplied = args.args.filter((entry) => OVERWRITE_FLAGS.has(entry))
      const injected = []
      if (binaryName === 'ffmpeg') {
        if (!args.args.includes('-hide_banner')) injected.push('-hide_banner')
        // A visible log level unless the caller set one: ffmpeg's default is
        // chatty enough that the interesting line scrolls out of a capped
        // answer, and `-loglevel warning` keeps the diagnosis without the noise.
        const hasLevel = args.args.some((entry) => entry === '-loglevel' || entry === '-v' || entry.startsWith('-loglevel='))
        if (!hasLevel) injected.push('-loglevel', 'warning')
        if (!args.args.includes('-nostdin')) injected.push('-nostdin')
        if (supplied.length === 0) injected.push(args.overwrite === true ? '-y' : '-n')
      }
      const argv = [...injected, ...args.args]

      const timeoutMs = clampTimeout(args.timeoutMs)
      const result = await runBinary({
        file: binary.file,
        args: argv,
        cwd,
        timeoutMs,
        maxOutputChars: clampOutput(args.maxOutputChars),
        signal: exec.signal,
      })
      const lines = []
      lines.push(commandLine(binaryName, argv))
      lines.push('')
      lines.push(
        (result.timedOut ? 'KILLED after ' : 'exit ') +
          (result.timedOut ? timeoutMs + ' ms' : String(result.code)) +
          ' in ' +
          result.ms +
          ' ms' +
          (result.aborted ? ' (the turn was cancelled)' : '') +
          (result.signal && !result.timedOut ? ' (signal ' + result.signal + ')' : ''),
      )
      if (result.spawnError) lines.push('could not start the binary: ' + result.spawnError)
      const written = outputsOf(result.output)
      if (written.length > 0) {
        lines.push('')
        lines.push('files named in the log:')
        for (const file of written) {
          const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file)
          let size = null
          try {
            size = (await fsp.stat(absolute)).size
          } catch (err) {
            size = null
          }
          lines.push('  ' + absolute + (size === null ? '  (not written)' : '  ' + formatBytes(size)))
        }
      }
      if (result.dropped > 0) lines.push('output trimmed: ' + result.dropped + ' characters dropped from the middle')
      lines.push('')
      lines.push('--- ' + binaryName + ' said ---')
      lines.push(result.output.trim() === '' ? '(nothing)' : result.output.trim())
      if (result.code !== 0 && !result.timedOut) {
        lines.push('')
        lines.push('The last ffmpeg/ffprobe lines above are its own diagnosis of that exit code.')
      }
      return {
        text: lines.join('\n'),
        view: {
          file: written.length > 0 ? path.resolve(cwd, written[written.length - 1]) : '',
          command: commandLine(binaryName, argv),
          binary: binaryName,
          exitCode: result.code ?? undefined,
          timedOut: result.timedOut || undefined,
          ms: result.ms,
          outputs: written.map((file) => path.resolve(cwd, file)),
        },
      }
    },
  }

  // -------------------------------------------------------------------------
  // media_frames
  // -------------------------------------------------------------------------
  const frames = {
    name: 'media_frames',
    description: [
      'Pull frames OUT of a video or image sequence as picture files. Give `at` (["00:00:05","1:02:03.5"], or seconds) for exact moments, or `count` to sample the whole thing evenly - 9 frames across an hour is a storyboard in one call.',
      'Set `sheet: true` to get ONE tiled contact sheet instead of separate files, which is the cheapest way to look at a video\'s content as a picture.',
      'Each written file is named after the source, create-exclusively (nothing existing is ever replaced), and the answer reports its REAL pixel dimensions read back out of the file\'s own header - so a frame that came out the wrong size says so.',
      'A video cannot be read directly the way text can, and a single frame is not a summary of one: use media_probe for the facts and this to see what is in it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        at: { type: 'array', items: { type: 'string' }, description: 'Exact timestamps to grab, e.g. ["5","00:01:30"] or ["1:02:03.250"]. Ignored when sheet is true.' },
        count: { type: 'number', description: 'How many frames to sample evenly across the file when `at` is not given (default 1). With sheet it is the number of tiles, default 9.' },
        width: { type: 'number', description: 'Scale each frame to this width in pixels, keeping the aspect (default 640, 16 to 4096).' },
        format: { type: 'string', enum: ['png', 'jpg'], description: 'Frame format. Default png.' },
        sheet: { type: 'boolean', description: 'Write ONE contact sheet (a tiled grid of the sampled frames) instead of separate files.' },
        outDir: { type: 'string', description: 'Directory to write into: relative to the conversation workspace, or absolute. Default: a `frames` folder beside the source file.' },
        timeoutMs: { type: 'number', description: 'Kill each ffmpeg call after this many milliseconds (default 120000, maximum 600000). Sampling a very large video needs a bigger one.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => ({ card: 'generic', title: 'Frames from ' + (args && args.path ? String(args.path) : 'a video'), kind: 'other' }),
    presentResult: (args, result) => ({ card: 'generic', title: 'Frames', content: result.text }),
    async execute(args, exec) {
      const resolved = await targetOf(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const ffmpeg = await binaryFor('ffmpeg')
      if (!ffmpeg.ok) return { text: ffmpeg.message, view: viewOf(target) }
      const width = Math.max(MIN_FRAME_WIDTH, Math.min(MAX_FRAME_WIDTH, Math.floor(Number.isFinite(args.width) ? Number(args.width) : 640)))
      const extension = args.format === 'jpg' ? 'jpg' : 'png'
      const sheet = args.sheet === true

      // Where the frames go: a `frames` folder beside the source by default,
      // which is where a person looking at the file will look for them.
      let outDir
      try {
        outDir =
          typeof args.outDir === 'string' && args.outDir.trim() !== ''
            ? (await resolveDirectory(deps.ctx, { session: sessionOf(exec), path: args.outDir, create: true, label: 'output directory' })).directory
            : path.join(path.dirname(target.file), 'frames')
      } catch (err) {
        return { text: err && err.message ? String(err.message) : String(err), view: viewOf(target) }
      }
      try {
        await fsp.mkdir(outDir, { recursive: true })
      } catch (err) {
        return { text: 'Could not create ' + outDir + ': ' + (err && err.message ? String(err.message) : String(err)), view: viewOf(target) }
      }

      const attempts = []
      const written = []
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

      if (sheet) {
        // One tiled picture: sample `count` frames across the file, scale them,
        // and lay them out in the grid closest to square.
        const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(Number.isFinite(args.count) ? Number(args.count) : 9)))
        const probe = await binaryFor('ffprobe')
        let duration = null
        if (probe.ok) {
          const answer = await probeJson({ file: probe.file, path: target.file, signal: exec.signal })
          if (answer.ok) duration = summarize({ file: target.file, size: target.size, json: answer.json, path: target.file }).durationSec
        }
        if (duration === null || !(duration > 0)) {
          return {
            text: 'A contact sheet needs the file\'s duration, and ' + path.basename(target.file) + ' does not report one. Ask for exact timestamps with `at` instead, or probe the file first.',
            view: viewOf(target),
          }
        }
        const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
        const rows = Math.max(1, Math.ceil(count / columns))
        const interval = duration / count
        const filter = 'fps=' + (1 / interval).toFixed(6) + ',scale=' + width + ':-1,tile=' + columns + 'x' + rows
        const output = await freeName(outDir, stemOf(target.file) + '-sheet-' + stamp + '.' + extension)
        const argv = ['-hide_banner', '-nostdin', '-n', '-i', target.file, '-vf', filter, '-frames:v', '1', ...qualityFlags(extension), output]
        attempts.push(commandLine('ffmpeg', argv))
        const result = await runBinary({ file: ffmpeg.file, args: argv, cwd: outDir, timeoutMs: clampTimeout(args.timeoutMs), signal: exec.signal })
        const size = await imageSizeOf(output)
        if (size === null) {
          await fsp.rm(output, { force: true }).catch(() => {})
          return {
            text:
              'The contact sheet could not be built (ffmpeg exited ' + String(result.code) + ').\n\n' +
              attempts.join('\n') +
              '\n\n--- ffmpeg said ---\n' +
              (result.output.trim() || '(nothing)') +
              '\n\nA file with no decodable video frames is the usual cause - media_probe reports what is actually in it.',
            view: viewOf(target),
          }
        }
        written.push({ file: output, ...size, bytes: await sizeOf(output) })
        return {
          text: framesText(target, written, attempts, count + ' tiles across ' + formatDuration(duration), result),
          view: viewOf(target, { frames: written.map((entry) => entry.file), duration: duration ?? undefined }),
        }
      }

      // Individual frames. `at` wins; otherwise sample `count` evenly.
      const explicit = Array.isArray(args.at) ? args.at.map(parseTimestamp) : []
      if (Array.isArray(args.at) && explicit.some((value) => value === null)) {
        return {
          text: 'Those timestamps do not parse: ' + args.at.filter((value, index) => explicit[index] === null).join(', ') + '. Use seconds ("12.5") or "HH:MM:SS.mmm".',
          view: viewOf(target),
        }
      }
      let timestamps = explicit.filter((value) => value !== null)
      if (timestamps.length === 0) {
        const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(Number.isFinite(args.count) ? Number(args.count) : 1)))
        if (count === 1) timestamps = [0]
        else {
          const probe = await binaryFor('ffprobe')
          let duration = null
          if (probe.ok) {
            const answer = await probeJson({ file: probe.file, path: target.file, signal: exec.signal })
            if (answer.ok) duration = summarize({ file: target.file, size: target.size, json: answer.json, path: target.file }).durationSec
          }
          if (duration === null || !(duration > 0)) {
            return {
              text: 'Sampling ' + count + ' frames needs the file\'s duration, and ' + path.basename(target.file) + ' does not report one. Pass explicit timestamps with `at` instead.',
              view: viewOf(target),
            }
          }
          timestamps = Array.from({ length: count }, (_, index) => (duration * (index + 0.5)) / count)
        }
      }
      if (timestamps.length > MAX_FRAMES) {
        return { text: 'That is ' + timestamps.length + ' frames; this tool writes at most ' + MAX_FRAMES + ' in one call.', view: viewOf(target) }
      }
      const failures = []
      for (const [index, seconds] of timestamps.entries()) {
        const label = seconds.toFixed(3).replace('.', '_')
        const output = await freeName(outDir, stemOf(target.file) + '-frame' + String(index + 1).padStart(2, '0') + '-' + label + 's.' + extension)
        // `-ss` BEFORE `-i` is the fast seek: ffmpeg jumps to the keyframe
        // before it instead of decoding everything up to it.
        const argv = ['-hide_banner', '-nostdin', '-n', '-ss', seconds.toFixed(3), '-i', target.file, '-frames:v', '1', '-vf', 'scale=' + width + ':-1', ...qualityFlags(extension), output]
        attempts.push(commandLine('ffmpeg', argv))
        const result = await runBinary({ file: ffmpeg.file, args: argv, cwd: outDir, timeoutMs: clampTimeout(args.timeoutMs), signal: exec.signal })
        const size = await imageSizeOf(output)
        if (size === null) {
          // ffmpeg can exit 0 having written nothing (a seek past the end), and
          // it can leave a zero-byte file behind. Either way nothing readable
          // is there, and a stray file this tool created is this tool's to clean.
          await fsp.rm(output, { force: true }).catch(() => {})
          failures.push({ seconds, code: result.code, output: result.output.trim() })
          continue
        }
        written.push({ file: output, ...size, seconds, bytes: await sizeOf(output) })
      }
      if (written.length === 0) {
        const first = failures[0] ?? { code: null, output: '' }
        return {
          text:
            (first.code === 0
              ? 'ffmpeg exited 0 but wrote no frame.'
              : 'No frame could be written (ffmpeg exited ' + String(first.code) + ').') +
            '\n\n' +
            attempts.slice(0, 3).join('\n') +
            (first.output ? '\n\n--- ffmpeg said ---\n' + first.output : '') +
            '\n\nA timestamp past the end of the file is the usual cause, and it exits 0 because ffmpeg simply found nothing there; media_probe reports the duration.',
          view: viewOf(target),
        }
      }
      return {
        text: framesText(target, written, attempts, written.length + ' frame(s)', null) + (failures.length > 0 ? '\n\n' + failures.length + ' timestamp(s) produced nothing (past the end of the file?).' : ''),
        view: viewOf(target, { frames: written.map((entry) => entry.file) }),
      }
    },
  }

  /** One file's size, or null. */
  const sizeOf = async (file) => {
    try {
      return (await fsp.stat(file)).size
    } catch (err) {
      return null
    }
  }

  /** The answer both frame paths share. */
  const framesText = (target, written, attempts, summary, result) => {
    const lines = []
    lines.push(path.basename(target.file) + ' — ' + summary)
    lines.push('')
    for (const entry of written) {
      lines.push(
        '  ' +
          entry.file +
          '  ' +
          entry.width +
          'x' +
          entry.height +
          (entry.bytes !== null ? '  ' + formatBytes(entry.bytes) : '') +
          (entry.seconds !== undefined ? '  at ' + formatDuration(entry.seconds) : ''),
      )
    }
    if (result && result.code !== 0) {
      lines.push('')
      lines.push('ffmpeg exited ' + String(result.code) + '; the frames above were still written.')
    }
    lines.push('')
    lines.push('commands run:')
    for (const attempt of attempts.slice(0, 6)) lines.push('  ' + attempt)
    if (attempts.length > 6) lines.push('  … and ' + (attempts.length - 6) + ' more')
    return lines.join('\n')
  }

  return [probe, run, frames]
}

/**
 * The files an ffmpeg run named as outputs, read from its own log.
 *
 * ffmpeg prints `Output #0, mp4, to 'out.mp4':` - one line per output, and
 * nothing else in a normal run prints that shape. It is a log, so this is a
 * convenience and not a contract: a file the log names is then stat'ed, and one
 * that is not there is reported as not written rather than assumed.
 */
export function outputsOf(output) {
  const found = []
  for (const line of String(output ?? '').split('\n')) {
    const match = /^Output #\d+,\s*[^,]+,\s*to '(.+)':\s*$/.exec(line.trim())
    if (match) found.push(match[1])
  }
  return found
}
