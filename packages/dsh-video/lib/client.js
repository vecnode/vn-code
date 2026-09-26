/**
 * dsh-video — browser half.
 *
 * A `video` TAB TYPE for the pack's right bar (dsh-rightbar): MP4, MOV, WebM,
 * MKV, AVI, WMV, FLV, OGV, MPEG-TS and 3GP open in a player that fits the pane,
 * with a facts panel and - when the browser cannot decode what is inside the
 * file - the one action that fixes it.
 *
 * The type registers at the `extension` band with the video patterns, which is
 * what wins the address: the shipped document preview claims
 * `dsh-resource://file/**` at the `fallback` band, and an `extension`-band type
 * outranks a `fallback` one, so a video opens here while every other file type
 * keeps exactly the surface it had. Audio formats are deliberately NOT claimed:
 * WAV/AIFF/FLAC are dsh-audio's waveform and MP3/M4A/Ogg are the shipped
 * preview's own player, so claiming them would take a surface away.
 *
 * Everything this tab shows comes from **dsh-media**'s host routes:
 *
 *   - `GET /api/dsh-media/file?...`   the bytes, WITH HTTP RANGE support. This
 *     is why the tab hands a URL to `<video>` instead of reading the file: the
 *     browser then streams it and seeks in it, so a 2 GB film starts playing at
 *     once and scrubbing works, which reading the bytes could never do.
 *   - `GET /api/dsh-media/report?...` the probe summary behind the facts panel,
 *     plus the verdict (`playable` / `image` / `remux` / `transcode`) and the
 *     exact ffmpeg command that would fix the last two.
 *   - `POST /api/dsh-media/remux` and `GET /api/dsh-media/job?id=` - the remux
 *     or transcode job, with ffmpeg's own progress, writing a cached MP4 this
 *     tab then plays through the same file route (`?cache=<key>`).
 *
 * The split is deliberate: ffmpeg has one owner in this pack, and the video tab
 * is a surface over it. A profile that installs this bundle without dsh-media
 * gets an honest sentence naming the missing package rather than a broken
 * player, and nothing here re-implements the host's path policy.
 *
 * Module-table format of every client bundle in this pack; no build step.
 */
/* global window, document, URL, fetch, AbortController, navigator */
window.__ModuleLoader__.load({
  id: 'dsh-video',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** This implementation's identity in the tab system, and its slot key. */
    const TYPE_ID = 'dsh-video'
    /** The tab kind this package owns. */
    const KIND = 'video'
    /** Version marker shown in the toolbar, so a loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.1'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_PREFIX = 'dsh-resource://file/'
    const SESSION_SEGMENT = 'session/'
    const ABSOLUTE_SEGMENT = 'absolute/'
    /** The keyed seats every tab type occupies in the right bar. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** dsh-media's routes: this package ships none of its own. */
    const MEDIA_API = '/api/dsh-media'
    const REPORT_ROUTE = MEDIA_API + '/report'
    const FILE_ROUTE = MEDIA_API + '/file'
    const REMUX_ROUTE = MEDIA_API + '/remux'
    const JOB_ROUTE = MEDIA_API + '/job'
    const PROVISION_ROUTE = MEDIA_API + '/provision'
    const STATE_ROUTE = MEDIA_API + '/state'
    /**
     * The extensions this type claims. dsh-media's own `VIDEO_EXTENSIONS` is the
     * same list - the host refuses to stream anything else through its file
     * route - and `check-media-node.mjs` pins both against the same literal, so
     * a tab that claims a format the route will not serve cannot ship.
     */
    const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'ogv', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'mts']
    /** How often the tab asks about a running conversion. */
    const JOB_POLL_MS = 700
    /** The step the -5s / +5s buttons take. */
    const SEEK_STEP = 5
    /** How many chapters the facts panel lists before it says how many are left. */
    const MAX_CHAPTER_ROWS = 200

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------
    /** Decode one encoded address segment, tolerating a malformed one. */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch (err) {
        return segment
      }
    }

    /**
     * Read the two address shapes this type claims.
     *
     * `dsh-resource://file/session/<sessionId>/<path>` is the ordinary file
     * grammar, and the one a click in the Files tab produces.
     * `dsh-resource://file/absolute/<path>` drops the leading `/` of a POSIX
     * path (and keeps an empty first segment for a UNC path), which is why the
     * absolute form is reassembled here: a path put back together wrongly would
     * silently point at another file, so the two Windows cases are explicit.
     *
     * @param address - a tab's content id.
     * @returns `{ sessionId, path }` or `{ absolute }`, or null.
     */
    function parseVideoAddress(address) {
      const value = typeof address === 'string' ? address : ''
      if (value.slice(0, FILE_PREFIX.length) !== FILE_PREFIX) return null
      const rest = value.slice(FILE_PREFIX.length)
      if (rest.slice(0, ABSOLUTE_SEGMENT.length) === ABSOLUTE_SEGMENT) {
        const tail = rest.slice(ABSOLUTE_SEGMENT.length)
        if (tail === '') return null
        const segments = tail.split('/').map(decodeSegment)
        // Three cases, and the first two are why this is not one expression:
        // a Windows drive (`C:/x/y.mp4`) carries its own root; a UNC path
        // (`//server/share/y.mp4`) keeps an EMPTY first segment, so prefixing a
        // slash is what restores it; a POSIX path simply lost its leading `/`.
        // Getting any of them wrong points the tab at another file.
        const absolute = /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : '/' + segments.join('/')
        return { absolute }
      }
      if (rest.slice(0, SESSION_SEGMENT.length) !== SESSION_SEGMENT) return null
      const tail = rest.slice(SESSION_SEGMENT.length)
      const cut = tail.indexOf('/')
      if (cut < 0) return null
      const filePath = tail
        .slice(cut + 1)
        .split('/')
        .map(decodeSegment)
        .join('/')
      if (filePath === '') return null
      return { sessionId: decodeSegment(tail.slice(0, cut)), path: filePath }
    }

    /** The decoded last path segment of an address, for the chip title. */
    function baseNameOf(address) {
      const parsed = parseVideoAddress(address)
      if (!parsed) return 'Video'
      const value = parsed.absolute ?? parsed.path
      const name = String(value).replace(/\\/g, '/').split('/').pop()
      return name === '' || name === undefined ? 'Video' : name
    }

    /** Whether an address names a video container (the only thing this claims). */
    function isVideoAddress(address) {
      const parsed = parseVideoAddress(address)
      if (!parsed) return false
      const value = String(parsed.absolute ?? parsed.path)
      const dot = value.lastIndexOf('.')
      if (dot <= 0) return false
      return VIDEO_EXTENSIONS.includes(value.slice(dot + 1).toLowerCase())
    }

    /** One stable key for an address, so effects re-run only on a real change. */
    function addressKey(parsed) {
      if (!parsed) return ''
      return parsed.absolute !== undefined ? 'abs:' + parsed.absolute : 'ws:' + parsed.sessionId + '/' + parsed.path
    }

    /** The query parameters dsh-media's routes take for one address. */
    function addressParams(parsed, sessionId) {
      const params = new URLSearchParams()
      if (parsed.absolute !== undefined) params.set('path', parsed.absolute)
      else {
        params.set('session', parsed.sessionId || sessionId || '')
        params.set('path', parsed.path)
      }
      return params
    }

    /** Bytes as a reader reads them. */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
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

    /** Seconds as `h:mm:ss` (or `m:ss` under an hour). */
    function formatDuration(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value < 0) return ''
      const total = Math.round(value)
      const s = total % 60
      const m = Math.floor(total / 60) % 60
      const hours = Math.floor(total / 3600)
      const pad = (number) => String(number).padStart(2, '0')
      return (hours > 0 ? hours + ':' + pad(m) : String(m)) + ':' + pad(s)
    }

    /** A frame rate as text, from the summary's own numbers. */
    function formatRate(rate) {
      if (!rate) return ''
      return rate.text
    }

    /** One `fetch` that always answers with JSON, and never throws silently. */
    async function fetchJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', ...(init ?? {}) })
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        body = null
      }
      if (!response.ok) {
        const message = body && body.error && body.error.message ? String(body.error.message) : 'HTTP ' + response.status
        const error = new Error(message)
        error.status = response.status
        error.code = body && body.error ? body.error.code : ''
        throw error
      }
      return body
    }

    /** What a browser's own `MediaError` code means, in one sentence. */
    function mediaErrorText(video) {
      const code = video && video.error ? video.error.code : 0
      // The numbers, not the `MediaError.MEDIA_ERR_*` constants: this file is
      // also loaded by the tracked check's stub context, where that global does
      // not exist, and a viewer that cannot explain a failure must still render.
      if (code === 1) return 'the load was aborted'
      if (code === 2) return 'the file could not be read from the host'
      if (code === 3) return 'the browser started decoding this file and failed - the file may be damaged, or one stream uses a codec it does not have'
      if (code === 4) return 'the browser will not play this container or codec at all'
      return 'the browser refused the file without saying why'
    }

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.dsv-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar, and every column's top band ends in the
   same hairline at y=76: the docking strip above a pane is 38px and the
   conversation header is min-height:76px, which is why the Files tab, the
   editor, History, Diagrams, the PDF reader and the image viewer all use a
   38px border-box header. */
.dsv-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;min-width:0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsv-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap}
.dsv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsv-btn:disabled{opacity:.45;cursor:default}
.dsv-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsv-spacer{flex:1;min-width:0}
.dsv-meta{flex:0 1 auto;display:flex;align-items:center;gap:8px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;overflow:hidden}
.dsv-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#666);font-family:ui-monospace,'Cascadia Code',Consolas,monospace}
.dsv-chip{flex:none;display:inline-flex;align-items:center;padding:0 6px;height:18px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsv-chip[data-warn="true"]{background:var(--dsw-alias-state-warning-bg,rgba(214,158,46,.18));color:var(--dsw-alias-state-warning-primary,#8a6d1f)}
.dsv-ver{flex:none;white-space:nowrap;opacity:.75}
.dsv-select{flex:none;max-width:190px;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px}
/* The stage: a black box the player FITS into. Nothing is ever scaled by a
   transform - the video is laid out at min(available) so a 4K film is visible
   whole in a narrow pane and a phone clip is not smeared across it. */
.dsv-main{flex:1;min-height:0;display:flex;overflow:hidden}
.dsv-stage{flex:1;min-width:0;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;background:#0a0a0a;overflow:hidden}
.dsv-video{display:block;max-width:100%;max-height:100%;width:auto;height:auto;background:#000;outline:none}
.dsv-side{flex:none;width:320px;min-width:0;height:100%;overflow:auto;box-sizing:border-box;border-left:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));background:var(--dsw-alias-bg-l1,rgba(127,127,127,.04));padding:12px;font-size:12px}
.dsv-sideTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);margin:0 0 8px}
.dsv-side.hidden{display:none}
.dsv-row{display:flex;gap:8px;padding:3px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12));min-width:0}
.dsv-rowKey{flex:none;width:96px;color:var(--dsw-alias-label-tertiary,#999)}
.dsv-rowValue{flex:1;min-width:0;word-break:break-word;font-variant-numeric:tabular-nums}
.dsv-stream{margin:0 0 10px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07))}
.dsv-streamHead{font-weight:500;margin-bottom:4px}
.dsv-chapter{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:3px 4px;border-radius:5px;cursor:pointer}
.dsv-chapter:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsv-chapterTime{color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;margin-right:6px}
.dsv-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,#c9c9c9);font-size:12.5px;line-height:18px;z-index:2;background:var(--dsw-alias-bg-l1,#141414)}
.dsv-stateTitle{font-size:13px;color:var(--dsw-alias-label-secondary,#ddd);font-weight:500}
.dsv-stateErr{color:var(--dsw-alias-state-error-primary,#ff7a70);max-width:560px;word-break:break-word}
.dsv-stateNote{max-width:560px;font-size:11.5px;opacity:.85;word-break:break-word}
.dsv-rowBtns{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center}
.dsv-warn{max-width:560px;font-size:12px;color:var(--dsw-alias-state-warning-primary,#e0b050);word-break:break-word}
.dsv-cmd{max-width:560px;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11.5px;text-align:left;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-all}
.dsv-progressBar{flex:none;height:3px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));overflow:hidden}
.dsv-progressFill{height:100%;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width .3s ease}
.dsv-error{color:var(--dsw-alias-state-error-primary,#ff7a70)}
`
    const CSS_TAG = 'dsh-video/video.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-video'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // The tab's own props
    // ---------------------------------------------------------------------
    /** The `useTabInfo` result, however the seat passed it. */
    function tabInfoNow(props) {
      if (!props || typeof props.useTabInfo !== 'function') return null
      try {
        return props.useTabInfo()
      } catch (err) {
        return null
      }
    }

    /** The address one tab body is showing. */
    function addressOf(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      return tab && typeof tab.contentId === 'string' ? tab.contentId : ''
    }

    // ---------------------------------------------------------------------
    // The facts: dsh-media's probe, fetched once per address
    // ---------------------------------------------------------------------
    /**
     * Fetch the probe summary for one address.
     *
     * @returns `[{ phase, facts, message, reason, sizeText, name }]` where
     *   `phase` is `loading`, `ready`, `unavailable` (no ffprobe on the host),
     *   `unreadable` (ffprobe refused the file), `missing` (dsh-media is not
     *   installed), `error` or `bad-address`.
     */
    function useFacts(parsed, sessionId, attempt) {
      const key = addressKey(parsed)
      const [state, setState] = useState({ phase: key === '' ? 'bad-address' : 'loading' })
      useEffect(() => {
        if (key === '') {
          setState({ phase: 'bad-address' })
          return undefined
        }
        const controller = new AbortController()
        let live = true
        setState({ phase: 'loading' })
        const url = REPORT_ROUTE + '?' + addressParams(parsed, sessionId).toString()
        fetchJson(url, { signal: controller.signal })
          .then((body) => {
            if (!live) return
            if (body.unavailable === true) setState({ phase: 'unavailable', message: String(body.message ?? ''), reason: String(body.reason ?? ''), facts: null })
            else if (body.unreadable === true) setState({ phase: 'unreadable', message: String(body.message ?? ''), facts: null, sizeText: body.sizeText })
            else setState({ phase: 'ready', facts: body.facts ?? null, sizeText: body.sizeText ?? '', name: body.name ?? '' })
          })
          .catch((err) => {
            if (!live) return
            if (err && err.name === 'AbortError') return
            const missing = err && (err.status === 404 || err.code === 'NOT_FOUND')
            setState({ phase: missing ? 'missing' : 'error', message: err && err.message ? String(err.message) : String(err), facts: null })
          })
        return () => {
          live = false
          controller.abort()
        }
        // `key` and `sessionId` identify the request; `attempt` is the retry.
      }, [key, sessionId, attempt])
      return state
    }

    /**
     * The conversion job, from dsh-media: start it, then poll it.
     *
     * The poll is a `setInterval` keyed on the job's ID and whether it is
     * running, NOT on the job object - every poll replaces that object, and an
     * effect that depended on it would tear down and rebuild its own timer on
     * every tick.
     */
    function useConversion(parsed, sessionId, onDone) {
      const [job, setJob] = useState(null)
      const [error, setError] = useState('')
      const [starting, setStarting] = useState(false)
      const key = addressKey(parsed)
      const running = job !== null && job.state === 'running'
      const jobId = job === null ? '' : String(job.id ?? '')
      const doneRef = useRef(onDone)
      doneRef.current = onDone

      const start = useCallback(
        async (mode) => {
          if (key === '') return
          setError('')
          setStarting(true)
          try {
            const body = await fetchJson(REMUX_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: parsed.absolute !== undefined ? '' : parsed.sessionId || sessionId || '', path: parsed.absolute ?? parsed.path, mode: mode === 'remux' || mode === 'transcode' ? mode : undefined }),
            })
            setJob(body.job ?? null)
          } catch (err) {
            setError(err && err.message ? String(err.message) : String(err))
          } finally {
            setStarting(false)
          }
        },
        [key, sessionId],
      )

      useEffect(() => {
        if (!running || jobId === '') return undefined
        let live = true
        const tick = async () => {
          try {
            const body = await fetchJson(JOB_ROUTE + '?id=' + encodeURIComponent(jobId))
            if (!live || !body.job) return
            setJob(body.job)
            if (body.job.state === 'done' && typeof doneRef.current === 'function') doneRef.current(body.job)
          } catch (err) {
            if (!live) return
            setError(err && err.message ? String(err.message) : String(err))
            setJob((current) => (current === null ? current : { ...current, state: 'failed', error: err && err.message ? String(err.message) : String(err) }))
          }
        }
        const timer = setInterval(tick, JOB_POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [running, jobId])

      const reset = useCallback(() => {
        setJob(null)
        setError('')
      }, [])
      return { job, error, starting, start, reset }
    }

    // ---------------------------------------------------------------------
    // The facts panel
    // ---------------------------------------------------------------------
    /** One label/value row. */
    function Row(props) {
      return h('div', { className: 'dsv-row' }, h('div', { className: 'dsv-rowKey' }, props.label), h('div', { className: 'dsv-rowValue' }, props.value))
    }

    /** One stream's block: the fields a viewer asks about, in that order. */
    function StreamBlock(props) {
      const stream = props.stream
      const parts = []
      if (stream.type === 'video') {
        if (stream.width && stream.height) parts.push(stream.width + ' x ' + stream.height)
        if (stream.dar) parts.push('display ' + stream.dar)
        const rate = formatRate(stream.rate)
        if (rate) parts.push(rate + ' (exact ' + stream.rate.rational + ')')
        if (stream.pixelFormat) parts.push(stream.pixelFormat + (stream.bitDepth ? ', ' + stream.bitDepth + '-bit' : ''))
        if (stream.fieldOrder && stream.fieldOrder !== 'progressive') parts.push(stream.fieldOrder)
        if (stream.rotation !== null && stream.rotation !== undefined && stream.rotation !== 0) parts.push('rotated ' + stream.rotation + '°')
      } else if (stream.type === 'audio') {
        if (stream.sampleRate) parts.push(stream.sampleRate + ' Hz')
        if (stream.channels) parts.push(stream.channels + ' channel' + (stream.channels === 1 ? '' : 's'))
        if (stream.channelLayout) parts.push(stream.channelLayout)
        if (stream.bitDepth) parts.push(stream.bitDepth + '-bit')
      }
      if (stream.bitRate) parts.push(Math.round(stream.bitRate / 1000) + ' kb/s')
      if (stream.frames) parts.push(stream.frames + ' frames')
      if (stream.language) parts.push(stream.language)
      if (stream.title) parts.push(stream.title)
      if (stream.dispositions && stream.dispositions.indexOf('default') >= 0) parts.push('default')
      if (stream.dispositions && stream.dispositions.indexOf('forced') >= 0) parts.push('forced')
      return h(
        'div',
        { className: 'dsv-stream' },
        h('div', { className: 'dsv-streamHead' }, stream.type + ' #' + stream.index + ' — ' + stream.codec + (stream.profile && stream.profile !== 'unknown' ? ' (' + stream.profile + ')' : '')),
        h('div', null, parts.join(' · ')),
      )
    }

    /** The panel: what the file is, what is in it, and what the browser can do. */
    function FactsPanel(props) {
      const facts = props.facts
      const [copied, setCopied] = useState(false)
      const onChapter = props.onChapter
      if (!facts) return null
      const chapters = facts.chapters ?? []
      const verdict = facts.playable ?? { verdict: 'unknown', reason: '' }
      const copy = () => {
        const text = verdict.command
        if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
      return h(
        'div',
        { className: 'dsv-side', 'data-dsh-video': 'facts' },
        h('div', { className: 'dsv-sideTitle' }, 'File'),
        h(Row, { label: 'container', value: (facts.container.longName || facts.container.name || 'unknown') + ' [' + props.kind + ']' }),
        h(Row, { label: 'duration', value: facts.durationText }),
        h(Row, { label: 'bitrate', value: facts.bitRateText }),
        h(Row, { label: 'size', value: facts.sizeText }),
        h('div', { className: 'dsv-sideTitle', style: { marginTop: '12px' } }, 'Streams'),
        ...(facts.streams.length === 0 ? [h('div', null, 'ffprobe found no streams in this file.')] : facts.streams.map((stream) => h(StreamBlock, { key: 'stream-' + stream.index, stream }))),
        chapters.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dsv-sideTitle', style: { marginTop: '12px' } }, 'Chapters (' + chapters.length + ')'),
              ...chapters.slice(0, MAX_CHAPTER_ROWS).map((chapter) =>
                h(
                  'button',
                  { key: 'chapter-' + chapter.index, type: 'button', className: 'dsv-chapter', 'data-dsh-video': 'chapter', onClick: () => onChapter(chapter.startSec) },
                  h('span', { className: 'dsv-chapterTime' }, formatDuration(chapter.startSec)),
                  chapter.title || '(untitled)',
                ),
              ),
            )
          : null,
        Object.keys(facts.container.tags ?? {}).length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dsv-sideTitle', style: { marginTop: '12px' } }, 'Tags'),
              ...Object.entries(facts.container.tags).map(([key, value]) => h(Row, { key: 'tag-' + key, label: key, value: String(value) })),
            )
          : null,
        h('div', { className: 'dsv-sideTitle', style: { marginTop: '12px' } }, 'In a browser'),
        h('div', { 'data-dsh-video': 'verdict', 'data-verdict': verdict.verdict }, verdict.reason),
        verdict.command
          ? h(
              'div',
              { style: { marginTop: '8px' } },
              h('div', { className: 'dsv-cmd' }, verdict.command),
              h('button', { type: 'button', className: 'dsv-btn', style: { marginTop: '6px' }, onClick: copy }, copied ? 'Copied' : 'Copy command'),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // The tab body
    // ---------------------------------------------------------------------
    /**
     * The video pane: toolbar, stage, optional facts panel.
     *
     * The player is handed a URL, never bytes: the host route supports HTTP
     * Range, so the browser streams and seeks. Reading the file into memory
     * first would make a large film impossible and scrubbing worse, which is the
     * whole reason this tab has a host route instead of the workspace remote.
     */
    function VideoBody(props) {
      const address = addressOf(props)
      const parsed = useMemo(() => parseVideoAddress(address), [address])
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
      const [attempt, setAttempt] = useState(0)
      const factsState = useFacts(parsed, sessionId, attempt)
      const [showFacts, setShowFacts] = useState(false)
      const [source, setSource] = useState(null)
      const [playError, setPlayError] = useState('')
      const [dismissed, setDismissed] = useState(false)
      const [provisioning, setProvisioning] = useState(false)
      const videoRef = useRef(null)

      /** The URL the <video> element is given for one address, or for a cache. */
      const directUrl = useMemo(() => (parsed === null ? '' : FILE_ROUTE + '?' + addressParams(parsed, sessionId).toString()), [addressKey(parsed), sessionId])

      // A new address (or a retry) starts from the direct file again, and shows
      // whatever the host has to say about it rather than a dismissed notice.
      useEffect(() => {
        setSource(directUrl === '' ? null : { url: directUrl, kind: 'direct' })
        setPlayError('')
        setDismissed(false)
      }, [directUrl, attempt])

      const conversion = useConversion(parsed, sessionId, (job) => {
        setSource({ url: job.url, kind: 'cache' })
        setPlayError('')
      })

      const facts = factsState.facts
      const verdict = facts && facts.playable ? facts.playable.verdict : 'unknown'
      const needsWork = verdict === 'remux' || verdict === 'transcode'
      const job = conversion.job

      const seek = useCallback((seconds) => {
        const video = videoRef.current
        if (video && Number.isFinite(seconds)) video.currentTime = Math.max(0, seconds)
      }, [])

      const nudge = useCallback(
        (delta) => {
          const video = videoRef.current
          if (video && Number.isFinite(video.currentTime)) video.currentTime = Math.max(0, video.currentTime + delta)
        },
        [],
      )

      const startProvision = useCallback(async () => {
        setProvisioning(true)
        try {
          await fetchJson(PROVISION_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          // Poll the state until the pinned copy is installed, then re-probe.
          for (let step = 0; step < 900; step += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const state = await fetchJson(STATE_ROUTE)
            const phase = state.provision ? state.provision.state : ''
            if (phase === 'installed') {
              setAttempt((value) => value + 1)
              break
            }
            if (phase === 'failed' || phase === 'unsupported') break
          }
        } catch (err) {
          /* the state box below reports whatever the host said */
        } finally {
          setProvisioning(false)
        }
      }, [])

      const openFacts = facts !== null && facts !== undefined

      // ---------------------------------------------------------------------
      // The states that are not a playing video
      //
      // Only the two that leave nothing to hand the browser get their own
      // screen. Everything else - no ffmpeg, ffprobe refusing the file, the
      // host route erroring - is an OVERLAY on the live player, because in all
      // three cases the bytes may still be perfectly playable: "play it anyway"
      // has to reach the same <video> the tab already renders, and a screen that
      // returned early could only claim to.
      // ---------------------------------------------------------------------
      if (factsState.phase === 'bad-address') {
        return h(
          'div',
          { className: 'dsv-root', 'data-dsv-state': 'bad-address' },
          h(Toolbar, { name: baseNameOf(address), version: PLUGIN_VERSION }),
          h('div', { className: 'dsv-stage' }, h('div', { className: 'dsv-state' }, h('div', { className: 'dsv-stateTitle' }, 'This tab has no file address'), h('div', null, 'Open a video from the Files tab.'))),
        )
      }

      if (factsState.phase === 'loading') {
        return h(
          'div',
          { className: 'dsv-root', 'data-dsv-state': 'loading' },
          h(Toolbar, { name: baseNameOf(address), version: PLUGIN_VERSION }),
          h(
            'div',
            { className: 'dsv-stage' },
            h(
              'div',
              { className: 'dsv-state', 'data-dsh-video': 'opening' },
              h('div', { className: 'dsv-stateTitle' }, 'Reading the file'),
              h('div', null, (parsed && (parsed.absolute ?? parsed.path)) || address),
              h('div', { className: 'dsv-stateNote' }, 'ffprobe reads the container header - no frame is decoded, so this is as quick as opening the file.'),
            ),
          ),
        )
      }

      if (factsState.phase === 'missing') {
        return h(
          'div',
          { className: 'dsv-root', 'data-dsv-state': 'missing' },
          h(Toolbar, { name: baseNameOf(address), version: PLUGIN_VERSION }),
          h(
            'div',
            { className: 'dsv-stage' },
            h(
              'div',
              { className: 'dsv-state', 'data-dsh-video': 'missing-media' },
              h('div', { className: 'dsv-stateTitle' }, 'dsh-media is not installed'),
              h('div', { className: 'dsv-stateNote' }, 'This tab is a surface: the bytes, the probe and the ffmpeg that converts a container all belong to the dsh-media bundle, which owns /api/dsh-media/*. Install it (both installers pick every package under packages/) and reopen this tab.'),
              h('div', { className: 'dsv-stateErr' }, factsState.message ?? ''),
            ),
          ),
        )
      }

      /** The overlay one non-ready phase shows over the player. */
      const overlay = dismissed ? null : overlayFor(factsState, { provisioning, onProvision: startProvision, onRetry: () => setAttempt((value) => value + 1), onDismiss: () => setDismissed(true) })

      // ---------------------------------------------------------------------
      // The player
      // ---------------------------------------------------------------------
      const chapters = facts && Array.isArray(facts.chapters) ? facts.chapters : []
      return h(
        'div',
        { className: 'dsv-root', 'data-dsv-state': 'ready', 'data-dsv-facts': factsState.phase },
        h(
          Toolbar,
          {
            name: baseNameOf(address),
            version: PLUGIN_VERSION,
            facts,
            needsWork,
            verdict,
            showFacts,
            onToggleFacts: openFacts ? () => setShowFacts((value) => !value) : null,
            chapters,
            onChapter: seek,
            onNudge: nudge,
            converting: job !== null && job.state === 'running',
            starting: conversion.starting,
            onConvert: () => conversion.start(verdict === 'remux' ? 'remux' : 'transcode'),
          },
        ),
        job !== null && job.state === 'running' ? h('div', { className: 'dsv-progressBar' }, h('div', { className: 'dsv-progressFill', style: { width: (job.percent ?? 0) + '%' } })) : null,
        h(
          'div',
          { className: 'dsv-main' },
          h(
            'div',
            { className: 'dsv-stage', 'data-dsh-video': 'stage' },
            source !== null
              ? h('video', {
                  key: source.url,
                  ref: videoRef,
                  className: 'dsv-video',
                  src: source.url,
                  controls: true,
                  playsInline: true,
                  preload: 'metadata',
                  'data-dsh-video-source': source.kind,
                  onError: () => setPlayError(mediaErrorText(videoRef.current)),
                })
              : h('div', { className: 'dsv-state' }, h('div', { className: 'dsv-stateTitle' }, 'Nothing to play yet')),
            overlay,
            playError !== ''
              ? h(
                  'div',
                  { className: 'dsv-state', 'data-dsh-video': 'play-error' },
                  h('div', { className: 'dsv-stateTitle' }, 'The browser could not play this file'),
                  h('div', { className: 'dsv-stateErr' }, playError),
                  needsWork ? h('div', { className: 'dsv-warn' }, 'ffprobe says: ' + verdict.reason + (verdict.command ? ' — ' + verdict.command : '')) : null,
                  h(
                    'div',
                    { className: 'dsv-rowBtns' },
                    needsWork
                      ? h('button', { type: 'button', className: 'dsv-btn', disabled: conversion.starting, 'data-dsh-video': 'convert', onClick: () => conversion.start(verdict === 'remux' ? 'remux' : 'transcode') }, conversion.starting ? 'Starting…' : verdict === 'remux' ? 'Remux it (instant, no quality loss)' : 'Convert it to H.264')
                      : null,
                    h('button', { type: 'button', className: 'dsv-btn', onClick: () => { setPlayError(''); setSource({ url: directUrl, kind: 'direct' }) } }, 'Try again'),
                  ),
                  conversion.error !== '' ? h('div', { className: 'dsv-stateErr' }, conversion.error) : null,
                )
              : null,
            job !== null && job.state === 'failed' && playError === ''
              ? h('div', { className: 'dsv-state', 'data-dsh-video': 'job-failed' }, h('div', { className: 'dsv-stateTitle' }, 'The conversion failed'), h('div', { className: 'dsv-stateErr' }, job.error ?? ''), h('button', { type: 'button', className: 'dsv-btn', onClick: conversion.reset }, 'Dismiss'))
              : null,
          ),
          showFacts && openFacts
            ? h(FactsPanel, {
                facts,
                kind: factsKind(facts),
                onChapter: (seconds) => {
                  seek(seconds)
                  const video = videoRef.current
                  if (video && typeof video.play === 'function') video.play().catch(() => {})
                },
              })
            : null,
        ),
      )
    }

    /**
     * The overlay for one non-ready probe phase: what happened, and the buttons
     * that can still get the file playing.
     */
    function overlayFor(state, actions) {
      if (state.phase === 'unavailable') {
        return h(
          'div',
          { className: 'dsv-state', 'data-dsh-video': 'no-ffmpeg' },
          h('div', { className: 'dsv-stateTitle' }, 'No ffmpeg on this machine yet'),
          h('div', { className: 'dsv-stateNote' }, state.message ?? ''),
          h(
            'div',
            { className: 'dsv-rowBtns' },
            h('button', { type: 'button', className: 'dsv-btn', disabled: actions.provisioning, onClick: actions.onProvision, 'data-dsh-video': 'get-ffmpeg' }, actions.provisioning ? 'Downloading…' : 'Download the pinned ffmpeg'),
            h('button', { type: 'button', className: 'dsv-btn', 'data-dsh-video': 'play-anyway', onClick: actions.onDismiss }, 'Play it anyway'),
          ),
        )
      }
      if (state.phase === 'unreadable' || state.phase === 'error') {
        return h(
          'div',
          { className: 'dsv-state', 'data-dsh-video': state.phase },
          h('div', { className: 'dsv-stateTitle' }, state.phase === 'unreadable' ? 'ffprobe could not read this file' : 'The file could not be inspected'),
          h('div', { className: 'dsv-stateErr' }, state.message ?? ''),
          h('div', { className: 'dsv-stateNote' }, 'The file may still play: the browser decodes it on its own, without ffprobe.'),
          h(
            'div',
            { className: 'dsv-rowBtns' },
            h('button', { type: 'button', className: 'dsv-btn', 'data-dsh-video': 'play-anyway', onClick: actions.onDismiss }, 'Play it anyway'),
            h('button', { type: 'button', className: 'dsv-btn', onClick: actions.onRetry }, 'Read it again'),
          ),
        )
      }
      return null
    }

    /** The short container name the facts panel shows in brackets. */
    function factsKind(facts) {
      const name = String((facts && facts.container && facts.container.name) || '')
      if (name.startsWith('mov,mp4')) return 'mp4'
      if (name === 'matroska,webm') return 'matroska'
      return name.split(',')[0] || 'unknown'
    }

    /**
     * The 38px top bar: the file, its facts, the chapter jump, the -5s / +5s
     * buttons, the facts toggle, and the conversion action when there is one.
     */
    function Toolbar(props) {
      const facts = props.facts
      const video = facts && facts.video && facts.video.length > 0 ? facts.video[0] : null
      const bits = []
      if (facts) {
        if (facts.durationText) bits.push(facts.durationText)
        if (video && video.width && video.height) bits.push(video.width + 'x' + video.height)
        if (facts.sizeText) bits.push(facts.sizeText)
      }
      return h(
        'div',
        { className: 'dsv-tools' },
        h('span', { className: 'dsv-name', title: props.name }, props.name),
        facts
          ? h(
              'span',
              { className: 'dsv-meta' },
              ...bits.map((bit, index) => h('span', { className: 'dsv-chip', key: 'bit-' + index }, bit)),
              props.verdict && props.verdict !== 'playable' && props.verdict !== 'image' ? h('span', { className: 'dsv-chip', 'data-warn': 'true', 'data-dsh-video': 'verdict-chip' }, props.verdict) : null,
            )
          : null,
        h('span', { className: 'dsv-spacer' }),
        props.onNudge
          ? h(
              'span',
              { className: 'dsv-meta' },
              h('button', { type: 'button', className: 'dsv-btn', title: 'Back ' + SEEK_STEP + ' seconds', onClick: () => props.onNudge(-SEEK_STEP) }, '−' + SEEK_STEP + 's'),
              h('button', { type: 'button', className: 'dsv-btn', title: 'Forward ' + SEEK_STEP + ' seconds', onClick: () => props.onNudge(SEEK_STEP) }, '+' + SEEK_STEP + 's'),
            )
          : null,
        props.chapters && props.chapters.length > 0
          ? h(
              'select',
              {
                className: 'dsv-select',
                'data-dsh-video': 'chapters',
                value: '',
                onChange: (event) => {
                  if (event.target.value !== '') props.onChapter(Number(event.target.value))
                  event.target.value = ''
                },
              },
              h('option', { value: '' }, 'Chapters (' + props.chapters.length + ')'),
              ...props.chapters.map((chapter) => h('option', { key: 'chapter-option-' + chapter.index, value: String(chapter.startSec) }, formatDuration(chapter.startSec) + '  ' + (chapter.title || '(untitled)'))),
            )
          : null,
        props.needsWork && props.onConvert
          ? h('button', { type: 'button', className: 'dsv-btn', disabled: props.converting || props.starting, 'data-dsh-video': 'convert', onClick: props.onConvert }, props.converting ? 'Converting…' : props.verdict === 'remux' ? 'Remux to MP4' : 'Convert for the browser')
          : null,
        props.onToggleFacts
          ? h('button', { type: 'button', className: 'dsv-btn', 'data-active': props.showFacts ? 'true' : undefined, 'data-dsh-video': 'facts-toggle', onClick: props.onToggleFacts }, 'Facts')
          : null,
        h('span', { className: 'dsv-meta dsv-ver' }, 'v' + props.version),
      )
    }

    /** The chip title: the file's own name. */
    function VideoTitle(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      return h('span', { className: 'dsv-name', 'data-dsh-video': 'title' }, baseNameOf(tab ? tab.contentId : ''))
    }

    // ---------------------------------------------------------------------
    // The tab type
    // ---------------------------------------------------------------------
    /**
     * The `video` type: an `extension`-band type for the video containers, which
     * outranks the shipped preview's `fallback` type for the same address and
     * leaves every other file type untouched. `canOpen` is what keeps a
     * non-video address out of this tab even if a pattern ever matched one, and
     * it accepts BOTH address shapes - the session one and the ordinary
     * `absolute` one a chat attachment or a file outside the workspace arrives
     * as, which this tab can serve because dsh-media's route reads absolute
     * paths.
     *
     * There is deliberately no `guide` entry: a blank video is not a document
     * anyone opens from the "+" control, so this type only ever claims a real
     * file address.
     */
    function videoDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        patterns: VIDEO_EXTENSIONS.map((extension) => '*.' + extension),
        priority: 'extension',
        canOpen: (address) => isVideoAddress(address),
        title: (address) => baseNameOf(address),
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services activation waits for: the seats and the tab registry. */
    const inject = ['slots', 'sidebarRightTabs']

    /**
     * Activate the browser half.
     * @param ctx - cordis context (inject: slots, sidebarRightTabs).
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(videoDefinition()), 'dsh-video: video tab type')
        ctx.effect(
          () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, VideoBody)),
          'dsh-video: video tab body',
        )
        ctx.effect(
          () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, VideoTitle)),
          'dsh-video: video tab title',
        )
        ctx.logger?.debug?.('[dsh-video] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-video] activation failed', err)
        ctx.logger?.warn?.('[dsh-video] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-video'
    exports.inject = inject
    exports.apply = apply
    /** The pure half, so the tracked check can drive it without a browser. */
    exports.__internals = {
      VIDEO_EXTENSIONS,
      parseVideoAddress,
      isVideoAddress,
      baseNameOf,
      formatBytes,
      formatDuration,
      mediaErrorText,
      factsKind,
      // The pieces that are pure props -> markup, exported so the tracked check
      // can RENDER them: a server render never runs an effect, so the tab body
      // it can reach is always the loading state - which would leave the facts
      // panel, the chapter jumps and the conversion buttons untested markup.
      Toolbar,
      FactsPanel,
      overlayFor,
      REPORT_ROUTE,
      FILE_ROUTE,
      REMUX_ROUTE,
      JOB_ROUTE,
      PROVISION_ROUTE,
      STATE_ROUTE,
    }
    return module.exports
  },
})
