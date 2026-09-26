/**
 * dsh-media — what a media file IS, in ffprobe's own words and in a person's.
 *
 * `media_probe` and the video tab both read a file through this module, so the
 * answer the model gets and the answer a person sees cannot drift: one ffprobe
 * run, one summary, one verdict about whether a browser can play it.
 *
 * Two rules shape the output:
 *
 *   - **ffprobe's numbers are kept, and translated next to them.** `30000/1001`
 *     stays visible as the exact rational while `29.97 fps` is what a reader
 *     wants, and both are reported because a rate is exactly rational and
 *     approximately decimal.
 *   - **The report says what it is not.** This is the container's own header as
 *     ffprobe reads it: no frame was decoded, so "0 frames" means the header
 *     does not say, and a stream ffprobe cannot identify is reported as
 *     unknown rather than omitted.
 *
 * The playability verdict is this plugin's opinion, and it is deliberately
 * narrow: it names the browser's own decoders (H.264, VP8, VP9, AV1, Theora,
 * AAC, MP3, Opus, Vorbis, FLAC, PCM in MP4/WebM/Ogg/WAV), and for everything
 * else it says whether a REMUX (`-c copy`) or a full TRANSCODE is what would
 * make it play - with the exact command that does it.
 */
import { runQuiet } from './run.js'

/** The one ffprobe invocation every reader here shares. */
export const PROBE_ARGS = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-show_error']

/** Codecs a browser decodes without help. */
const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le', 'pcm_mulaw', 'pcm_alaw'])
/** A still-picture codec: what ffprobe calls a "video stream" in an image file. */
const IMAGE_VIDEO = new Set(['png', 'mjpeg', 'gif', 'webp', 'bmp', 'tiff', 'avif', 'heif', 'jpeg2000', 'jpegls', 'targa', 'svg'])
/** Containers an image arrives in - ffprobe names each of these a "format". */
const IMAGE_CONTAINERS = new Set(['png_pipe', 'image2', 'jpeg_pipe', 'gif', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'avif', 'svg', 'ico', 'image2pipe'])
/** Containers a browser opens, by ffprobe's `format_name` (plus the extension). */
const NATIVE_CONTAINERS = new Set(['mov,mp4,m4a,3gp,3g2,mj2', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'adts'])
/** Video codecs a browser MAY play (hardware-dependent), named as such. */
const CONDITIONAL_VIDEO = new Set(['hevc', 'h265'])

/**
 * Run ffprobe over one file.
 *
 * @param options - `{ file: ffprobe, path, signal, timeoutMs }`.
 * @returns `{ ok, json, error, ms }` - a refusal is data, not a throw.
 */
export async function probeJson(options) {
  const result = await runQuiet({
    file: options.file,
    args: [...PROBE_ARGS, options.path],
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputChars: 4 * 1024 * 1024,
    signal: options.signal,
  })
  const text = String(result.output).trim()
  if (!result.ok && text === '') {
    return { ok: false, json: null, error: 'ffprobe exited with code ' + String(result.code) + ' and said nothing', ms: result.ms }
  }
  let parsed = null
  try {
    // ffprobe writes its JSON to stdout, but a warning can precede it - take
    // the last balanced object rather than trusting the first byte.
    const start = text.indexOf('{')
    parsed = start < 0 ? null : JSON.parse(text.slice(start))
  } catch (err) {
    return { ok: false, json: null, error: 'ffprobe did not answer with readable JSON: ' + text.split('\n')[0], ms: result.ms }
  }
  if (parsed && parsed.error && typeof parsed.error === 'object') {
    return { ok: false, json: parsed, error: String(parsed.error.string ?? 'ffprobe reported an error'), ms: result.ms }
  }
  return { ok: true, json: parsed, error: '', ms: result.ms }
}

// ---------------------------------------------------------------------------
// Numbers, as text
// ---------------------------------------------------------------------------
/** Bytes as a reader reads them. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'unknown size'
  if (value < 1024) return value + ' B'
  const units = ['kB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return (size >= 10 ? Math.round(size) : Math.round(size * 10) / 10) + ' ' + units[unit]
}

/** Seconds as `h:mm:ss.mmm`. */
export function formatDuration(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return 'unknown'
  const total = Math.round(value * 1000)
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  const pad = (number, width) => String(number).padStart(width, '0')
  return (h > 0 ? h + ':' + pad(m, 2) : String(m)) + ':' + pad(s, 2) + '.' + pad(ms, 3)
}

/** Bits per second, as a reader reads them. */
export function formatBitRate(bits) {
  const value = Number(bits)
  if (!Number.isFinite(value) || value <= 0) return 'unknown'
  if (value >= 1_000_000) return Math.round(value / 100_000) / 10 + ' Mb/s'
  return Math.round(value / 1000) + ' kb/s'
}

/** An ffprobe rational like `30000/1001` as a number, or null. */
export function rational(value) {
  const text = String(value ?? '')
  const slash = text.indexOf('/')
  if (slash < 0) {
    const number = Number(text)
    return Number.isFinite(number) ? number : null
  }
  const numerator = Number(text.slice(0, slash))
  const denominator = Number(text.slice(slash + 1))
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  return numerator / denominator
}

/** A frame rate as both its exact rational and its decimal reading. */
export function formatRate(value) {
  const text = String(value ?? '')
  const number = rational(text)
  if (number === null || number <= 0) return null
  const decimal = Math.round(number * 100) / 100
  return { rational: text, decimal, text: decimal + ' fps' }
}

/** A pixel aspect ratio / display aspect ratio, as text. */
function formatAspect(ratio, width, height) {
  const value = rational(ratio)
  const text = String(ratio ?? '')
  if (value !== null && value > 0 && Number.isFinite(value)) {
    if (text !== '0:1' && text !== '1:1') return text + ' (' + (Math.round(value * 100) / 100) + ':1)'
  }
  if (Number.isFinite(width) && Number.isFinite(height) && height > 0) {
    const divisor = greatestCommonDivisor(width, height)
    if (divisor > 0) return width / divisor + ':' + height / divisor
  }
  return null
}

/** Euclid, for the aspect ratio a reader recognises. */
function greatestCommonDivisor(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y) {
    const next = x % y
    x = y
    y = next
  }
  return x
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------
/** One `disposition` object as the few flags a reader cares about. */
function dispositions(stream) {
  const flags = stream && stream.disposition && typeof stream.disposition === 'object' ? stream.disposition : {}
  return Object.keys(flags).filter((key) => Number(flags[key]) === 1)
}

/** One stream, normalized. */
function summarizeStream(stream) {
  const type = String(stream.codec_type ?? 'unknown')
  const rate = formatRate(stream.avg_frame_rate ?? stream.r_frame_rate)
  const tags = stream.tags && typeof stream.tags === 'object' ? stream.tags : {}
  const rotation = (() => {
    const side = Array.isArray(stream.side_data_list) ? stream.side_data_list.find((entry) => entry && entry.rotation !== undefined) : null
    if (side) return Number(side.rotation)
    const tag = Number(tags.rotate)
    return Number.isFinite(tag) && tag !== 0 ? tag : null
  })()
  return {
    index: Number(stream.index ?? -1),
    type,
    codec: String(stream.codec_name ?? 'unknown'),
    codecLong: String(stream.codec_long_name ?? ''),
    profile: typeof stream.profile === 'string' ? stream.profile : '',
    level: stream.level !== undefined && Number(stream.level) >= 0 ? Number(stream.level) : null,
    width: Number.isFinite(stream.width) ? Number(stream.width) : null,
    height: Number.isFinite(stream.height) ? Number(stream.height) : null,
    sar: formatAspect(stream.sample_aspect_ratio, null, null),
    dar: formatAspect(stream.display_aspect_ratio, Number(stream.width), Number(stream.height)),
    rate,
    fieldOrder: typeof stream.field_order === 'string' && stream.field_order !== 'unknown' ? stream.field_order : '',
    pixelFormat: typeof stream.pix_fmt === 'string' ? stream.pix_fmt : '',
    bitDepth: bitDepthOf(stream.pix_fmt),
    sampleRate: Number.isFinite(stream.sample_rate) ? Number(stream.sample_rate) : Number(stream.sample_rate) || null,
    channels: Number.isFinite(stream.channels) ? Number(stream.channels) : null,
    channelLayout: typeof stream.channel_layout === 'string' ? stream.channel_layout : '',
    bitRate: Number(stream.bit_rate) > 0 ? Number(stream.bit_rate) : null,
    frames: Number(stream.nb_frames) > 0 ? Number(stream.nb_frames) : null,
    durationSec: Number(stream.duration) > 0 ? Number(stream.duration) : null,
    language: typeof tags.language === 'string' ? tags.language : '',
    title: typeof tags.title === 'string' ? tags.title : '',
    handler: typeof tags.handler_name === 'string' ? tags.handler_name : '',
    rotation,
    dispositions: dispositions(stream),
  }
}

/** Bits per component from a pixel format name, when the name says it. */
function bitDepthOf(pixelFormat) {
  const match = /p(\d{2})(le|be)?$/.exec(String(pixelFormat ?? ''))
  if (match) return Number(match[1])
  if (/yuvj?420p10/.test(String(pixelFormat))) return 10
  if (/yuvj?420p12/.test(String(pixelFormat))) return 12
  return null
}

/**
 * One ffprobe answer, as the facts every reader here shares.
 *
 * @param input - `{ file, size, json, path }`.
 * @returns the summary (never null: an unreadable file comes back with `error`).
 */
export function summarize(input) {
  const json = input.json && typeof input.json === 'object' ? input.json : {}
  const format = json.format && typeof json.format === 'object' ? json.format : {}
  const streams = Array.isArray(json.streams) ? json.streams.map(summarizeStream) : []
  const chapters = (Array.isArray(json.chapters) ? json.chapters : []).map((chapter, index) => ({
    index,
    startSec: Number(chapter.start_time) || 0,
    endSec: Number(chapter.end_time) || 0,
    title: chapter.tags && typeof chapter.tags.title === 'string' ? chapter.tags.title : '',
  }))
  const formatTags = format.tags && typeof format.tags === 'object' ? format.tags : {}
  const durationSec = Number(format.duration) > 0 ? Number(format.duration) : (streams.find((stream) => stream.durationSec)?.durationSec ?? null)
  const facts = {
    path: input.path ?? '',
    name: input.name ?? '',
    size: Number.isFinite(input.size) ? input.size : null,
    sizeText: Number.isFinite(input.size) ? formatBytes(input.size) : 'unknown size',
    container: {
      name: String(format.format_name ?? ''),
      longName: String(format.format_long_name ?? ''),
      tags: formatTags,
      probeScore: Number(format.probe_score) || null,
    },
    durationSec,
    durationText: durationSec === null ? 'unknown' : formatDuration(durationSec),
    bitRate: Number(format.bit_rate) > 0 ? Number(format.bit_rate) : null,
    bitRateText: formatBitRate(Number(format.bit_rate)),
    streams,
    video: streams.filter((stream) => stream.type === 'video'),
    audio: streams.filter((stream) => stream.type === 'audio'),
    subtitles: streams.filter((stream) => stream.type === 'subtitle'),
    others: streams.filter((stream) => stream.type !== 'video' && stream.type !== 'audio' && stream.type !== 'subtitle'),
    chapters,
    notes: [],
    error: input.error ? String(input.error) : '',
  }
  if (facts.container.name === '' && facts.streams.length === 0) {
    facts.notes.push('ffprobe found no container and no streams: that file is either empty, truncated before its first header, or not a media file at all.')
  }
  return { ...facts, playable: playability(facts) }
}

// ---------------------------------------------------------------------------
// Can a browser play it?
// ---------------------------------------------------------------------------
/** The container as a short name, using the extension to tell MKV from WebM. */
export function containerKind(facts) {
  const name = String(facts.container?.name ?? '')
  const extension = String(facts.path ?? '')
    .toLowerCase()
    .split('.')
    .pop()
  if (name === 'matroska,webm') return extension === 'webm' ? 'webm' : 'matroska'
  if (name.startsWith('mov,mp4,m4a,3gp,3g2,mj2')) return 'mp4'
  if (name === 'ogg') return 'ogg'
  if (name === 'wav') return 'wav'
  if (name === 'flac') return 'flac'
  if (name === 'mp3') return 'mp3'
  if (name === '' ) return 'unknown'
  return name.split(',')[0]
}

/**
 * The verdict, with the reason and the command that would fix it.
 *
 * `verdict` is one of:
 *   - `playable`   the browser decodes this container and these codecs as they are;
 *   - `image`      a still picture: open it, nothing to play;
 *   - `remux`      the codecs are fine, the container is not: `-c copy` fixes it;
 *   - `transcode`  a codec is not one a browser decodes: it must be re-encoded;
 *   - `unknown`    ffprobe could not say (no binary, unreadable file).
 */
export function playability(facts) {
  const kind = containerKind(facts)
  if (facts.error || (facts.streams.length === 0 && kind === 'unknown')) {
    return { verdict: 'unknown', container: kind, reason: facts.error || 'no streams were identified', command: '' }
  }
  const videoCodecs = facts.video.map((stream) => stream.codec)
  const audioCodecs = facts.audio.map((stream) => stream.codec)
  // A still picture is not a video that needs converting: ffprobe reports a PNG
  // as one video stream with no duration, and calling that "a browser does not
  // decode png" would be nonsense. An IMAGE gets its own verdict.
  const isImage =
    audioCodecs.length === 0 &&
    videoCodecs.length > 0 &&
    videoCodecs.every((codec) => IMAGE_VIDEO.has(codec)) &&
    (IMAGE_CONTAINERS.has(String(facts.container?.name ?? '')) || (facts.video[0].frames ?? 0) <= 1 || facts.durationSec === null)
  if (isImage) {
    const first = facts.video[0]
    return {
      verdict: 'image',
      container: kind,
      reason:
        'a still image' +
        (first && first.width && first.height ? ' (' + first.width + 'x' + first.height + ', ' + videoCodecs.join('/') + ')' : '') +
        ' - use the image tab or the frames it is made of; there is nothing to play',
      command: '',
    }
  }
  const unknownVideo = videoCodecs.filter((codec) => !NATIVE_VIDEO.has(codec))
  const unknownAudio = audioCodecs.filter((codec) => !NATIVE_AUDIO.has(codec))
  const nativeContainer = NATIVE_CONTAINERS.has(String(facts.container?.name ?? '')) || kind === 'webm'
  const conditional = unknownVideo.filter((codec) => CONDITIONAL_VIDEO.has(codec))
  const name = facts.name || facts.path || 'the file'
  const copyTarget = (() => {
    if (kind === 'matroska' || kind === 'mp4') return 'mp4'
    if (nativeContainer) return kind === 'webm' ? 'webm' : 'mp4'
    return 'mp4'
  })()

  if (nativeContainer && unknownVideo.length === 0 && unknownAudio.length === 0) {
    return { verdict: 'playable', container: kind, reason: 'the container and every stream use decoders a browser has', command: '' }
  }
  if (unknownVideo.length === 0 && unknownAudio.length === 0 && videoCodecs.every((codec) => codec === 'vp8' || codec === 'vp9' || codec === 'av1')) {
    return {
      verdict: 'remux',
      container: kind,
      reason: 'a browser decodes ' + videoCodecs.join('/') + ', but not the ' + kind + ' container: remuxing copies the streams without re-encoding',
      command: 'ffmpeg -i "' + name + '" -c copy "' + stripExtension(name) + '.' + copyTarget + '"',
    }
  }
  if (unknownVideo.length === 0 && unknownAudio.length === 0) {
    return {
      verdict: 'remux',
      container: kind,
      reason: 'the streams are browser-decodable, but the ' + kind + ' container is not one a browser opens - remuxing copies them without re-encoding',
      command: 'ffmpeg -i "' + name + '" -c copy "' + stripExtension(name) + '.' + copyTarget + '"',
    }
  }
  if (unknownVideo.length === 0 && videoCodecs.length === 0 && unknownAudio.length > 0) {
    return {
      verdict: 'transcode',
      container: kind,
      reason: 'audio-only, and a browser does not decode ' + unknownAudio.join('/'),
      command: 'ffmpeg -i "' + name + '" -vn -c:a aac -b:a 192k "' + stripExtension(name) + '.m4a"',
    }
  }
  const offending = [...unknownVideo, ...unknownAudio].join('/')
  const detail =
    conditional.length > 0 && conditional.length === unknownVideo.length
      ? offending + ' plays only where the browser has a hardware decoder for it (Safari and Edge, on machines that support it) - Chrome and Firefox do not'
      : 'a browser does not decode ' + offending
  return {
    verdict: 'transcode',
    container: kind,
    reason: detail,
    command: 'ffmpeg -i "' + name + '" -c:v libx264 -crf 20 -preset veryfast -c:a aac -b:a 160k "' + stripExtension(name) + '.mp4"',
  }
}

/** A file name without its extension (for the suggested output name). */
function stripExtension(name) {
  const text = String(name)
  const dot = text.lastIndexOf('.')
  return dot <= 0 ? text + '-playable' : text.slice(0, dot) + '-playable'
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
/** One line's worth of a stream, in the order a reader asks the questions. */
function streamLine(stream) {
  const parts = []
  if (stream.type === 'video') {
    const size = stream.width && stream.height ? stream.width + 'x' + stream.height : 'unknown size'
    parts.push(size + (stream.dar ? ' (' + stream.dar + ')' : ''))
    if (stream.rate) parts.push(stream.rate.text + ' (exact ' + stream.rate.rational + ')')
    if (stream.fieldOrder && stream.fieldOrder !== 'progressive') parts.push(stream.fieldOrder)
    if (stream.pixelFormat) parts.push(stream.pixelFormat + (stream.bitDepth ? ' (' + stream.bitDepth + '-bit)' : ''))
    if (stream.rotation !== null && stream.rotation !== 0) parts.push('rotated ' + stream.rotation + '°')
  } else if (stream.type === 'audio') {
    if (stream.sampleRate) parts.push(stream.sampleRate + ' Hz')
    if (stream.channels) parts.push(stream.channels + ' ch' + (stream.channelLayout ? ' (' + stream.channelLayout + ')' : ''))
    if (stream.bitDepth) parts.push(stream.bitDepth + '-bit')
  }
  if (stream.bitRate) parts.push(formatBitRate(stream.bitRate))
  if (stream.frames) parts.push(stream.frames + ' frames')
  const labels = []
  if (stream.language) labels.push(stream.language)
  if (stream.title) labels.push(stream.title)
  if (stream.handler && !stream.title) labels.push(stream.handler)
  if (stream.dispositions.includes('default')) labels.push('default')
  if (stream.dispositions.includes('forced')) labels.push('forced')
  const codec = stream.codec + (stream.profile && stream.profile !== 'unknown' ? ' (' + stream.profile + ')' : '')
  return (
    '  ' +
    stream.type.padEnd(8) +
    '#' +
    stream.index +
    '  ' +
    codec +
    (parts.length > 0 ? ' · ' + parts.join(' · ') : '') +
    (labels.length > 0 ? ' · ' + labels.join(', ') : '')
  )
}

/**
 * The readable report a tool call answers with.
 *
 * @param facts - the summary from `summarize`.
 * @param options - `{ elapsedMs, source }` - what produced this reading.
 */
export function formatReport(facts, options = {}) {
  const lines = []
  lines.push((facts.name || facts.path || 'the file') + ' — ' + facts.sizeText)
  const container = facts.container.longName || facts.container.name || 'unknown container'
  lines.push(
    'container: ' +
      container +
      (facts.container.name && facts.container.longName ? ' [' + containerKind(facts) + ']' : '') +
      ' · ' +
      facts.durationText +
      ' · ' +
      facts.bitRateText +
      ' · ' +
      facts.streams.length +
      ' stream' +
      (facts.streams.length === 1 ? '' : 's') +
      (options.source ? ' (via ' + options.source + ')' : ''),
  )
  if (facts.error) lines.push('ffprobe reported: ' + facts.error)
  if (facts.streams.length === 0) {
    lines.push('')
    lines.push('No streams at all: this file has no readable media in it.')
  } else {
    lines.push('')
    const ordered = [...facts.video, ...facts.audio, ...facts.subtitles, ...facts.others]
    for (const stream of ordered) lines.push(streamLine(stream))
  }
  const interestingTags = Object.entries(facts.container.tags ?? {}).filter(([key]) => key !== 'language')
  if (interestingTags.length > 0) {
    lines.push('')
    lines.push('tags: ' + interestingTags.map(([key, value]) => key + '=' + String(value)).join(', '))
  }
  if (facts.chapters.length > 0) {
    lines.push('')
    lines.push('chapters: ' + facts.chapters.length)
    for (const chapter of facts.chapters.slice(0, 40)) {
      lines.push('  ' + formatDuration(chapter.startSec) + ' → ' + formatDuration(chapter.endSec) + (chapter.title ? '  ' + chapter.title : ''))
    }
    if (facts.chapters.length > 40) lines.push('  … ' + (facts.chapters.length - 40) + ' more')
  }
  lines.push('')
  lines.push('browser: ' + facts.playable.verdict + ' — ' + facts.playable.reason)
  if (facts.playable.command) lines.push('to make it play: ' + facts.playable.command)
  for (const note of facts.notes) lines.push('note: ' + note)
  if (options.elapsedMs !== undefined) lines.push('read in ' + options.elapsedMs + ' ms (header only: no frame was decoded)')
  return lines.join('\n')
}
