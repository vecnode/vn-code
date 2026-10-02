// check-audio-browser.mjs — prove, in a REAL browser, the parts of dsh-audio's
// audio console that no Node check can: that the browser's own device list comes
// back and normalizes, that `setSinkId` really moves an AudioContext and a media
// element, that the package's OWN WAV encoder produces a file the browser really
// plays, that the generated tone really advances, and that the meter reads a real
// analyser frame off a real capture.
//
// Why this exists: `check-client-bundles.mjs` drives the console's numbers with
// hand-built fixtures and renders its markup from hand-built state, which is what
// makes the arithmetic verifiable on any host — but it proves nothing about the
// APIs the feature is BUILT ON, and those are exactly where a design like this can
// be wrong. `AudioContext.setSinkId` exists only from Chromium 110, a device list
// carries no labels until the page may capture audio, and `enumerateDevices`
// answers nothing at all outside a secure context. This check asks a throwaway
// headless Chromium for all of it: it serves the package's own browser bundle over
// loopback, loads it through the same module-table loader the shell uses, and
// drives everything the console drives — with React STUBBED, because nothing here
// renders (the markup is the Node check's job) and the bundle only needs `react`
// to define its components.
//
// It needs a Chromium-family browser. With none installed it SKIPS LOUDLY and
// exits 0 — a check that downloads a browser to pass is not a check. The fake
// device flags are what let a headless browser have a microphone at all, and the
// autoplay policy is what lets a tone start without a click; both are the standard
// automation flags, not a loosening of the feature.
//
// Run:  node scripts/checks/check-audio-browser.mjs [--keep]
export {} // (import-free: ESM for the dynamic imports below)

const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs')
const { createServer } = await import('node:http')
const { spawn } = await import('node:child_process')
const os = await import('node:os')
const path = (await import('node:path')).default
const { fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const keep = process.argv.includes('--keep')
const bundleFile = path.join(repo, 'packages', 'dsh-audio', 'lib', 'client.js')
const bundleSource = readFileSync(bundleFile, 'utf8')

let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(58) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/**
 * A Chromium-family browser on this machine, or null.
 *
 * Resolved here rather than imported: a check may reach into another package's
 * files, but a package may not, and this one has no reason to own an engine
 * resolver.
 */
function findBrowser() {
  const configured = process.env.DSH_CANVAS_BROWSER || process.env.DSH_AUDIO_BROWSER
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) return configured
  const candidates = []
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium')
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

const browser = findBrowser()
if (browser === null) {
  console.log('skip every audio browser check                          (no Chromium-family browser on this host)')
  console.log('     set DSH_AUDIO_BROWSER to a chrome/edge/chromium binary to run it')
  process.exitCode = 0
} else {
  console.log('browser: ' + browser)
  console.log('')

  // -------------------------------------------------------------------------
  // The page. It loads the package's own bundle through the shell's module-table
  // loader (React stubbed: nothing here renders), then drives the console's own
  // functions against the browser's real APIs and posts what happened back.
  // -------------------------------------------------------------------------
  const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-audio browser check</title>
<style>body{margin:0;background:#111;color:#eee;font:14px/1.5 system-ui,sans-serif;padding:16px}</style>
</head><body>
<p id="status">running…</p>
<script>
  window.__ModuleLoader__ = { load: (entry) => { window.__dshAudioEntry = entry } }
  // The console's components are DEFINED here and never rendered, so the stub only
  // has to exist and answer the hooks they destructure.
  window.__reactStub = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value === undefined ? null : value }),
    useCallback: (callback) => callback,
  }
</script>
<script src="/bundle.js"></script>
<script>
(async () => {
  const report = { errors: [] }
  const log = (message) => { const node = document.getElementById('status'); node.textContent = message; console.log('[audio-check] ' + message) }
  const post = (value) => fetch('/report', { method: 'POST', body: JSON.stringify(value) }).catch(() => {})
  const started = Date.now()
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const entry = window.__dshAudioEntry
    if (entry === undefined) throw new Error('the bundle did not register with the module loader')
    report.bundleId = entry.id
    const module = entry.factory((name) => (name === 'react' ? window.__reactStub : {}))
    const A = module === undefined || module.__internals === undefined ? undefined : module.__internals
    if (A === undefined) throw new Error('the bundle exposed no __internals')
    report.internals = Object.keys(A).length

    // 1. The two prototypes the routing verdict is built on, and the verdict the
    //    package reaches from them.
    report.contextSetSinkId = typeof AudioContext.prototype.setSinkId === 'function'
    report.elementSetSinkId = 'setSinkId' in HTMLMediaElement.prototype
    const routing = A.outputStrategyNow()
    report.routingKind = routing.kind
    report.routingSentence = routing.sentence

    // 2. Capture first: the device list carries no labels until the page may
    //    capture, and this check is here to prove exactly that.
    let stream = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      report.micError = String(err && err.message ? err.message : err)
    }
    const normalized = A.normalizeDevices(await navigator.mediaDevices.enumerateDevices())
    report.devices = {
      outputs: normalized.outputs.length,
      inputs: normalized.inputs.length,
      unnamed: normalized.unnamed,
      kinds: normalized.outputs.map((device) => device.kind).concat(normalized.inputs.map((device) => device.kind)),
    }
    report.defaultTarget = A.defaultTargetOf(normalized.outputs)
    report.firstOutput = normalized.outputs.length === 0 ? '' : A.deviceTitle(normalized.outputs[0], 0)

    // 3. The engine path: a real AudioContext, really running, really moved.
    const context = new AudioContext()
    await context.resume()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0.0001
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    report.contextState = context.state
    report.sampleRate = context.sampleRate
    if (typeof context.setSinkId === 'function') {
      try {
        await context.setSinkId('')
        report.sinkApplied = true
      } catch (err) {
        report.sinkApplied = false
        report.sinkError = String(err && err.message ? err.message : err)
      }
    }
    oscillator.stop()

    // 4. The element path, using the package's OWN numbers: the tone is generated,
    //    ENCODED by the bundle's encoder, and handed to a real <audio> element —
    //    which is the whole reason the encoder exists.
    const channels = A.toneChannels({ frequency: 440, level: 50, channel: 'both', sampleRate: context.sampleRate, seconds: 0.25 })
    const bytes = A.encodeWav(channels, context.sampleRate)
    report.wavBytes = bytes.length
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    const element = new Audio()
    element.src = url
    report.wavLoaded = await new Promise((resolve) => {
      element.onloadedmetadata = () => resolve(true)
      element.onerror = () => resolve(false)
      setTimeout(() => resolve(false), 4000)
    })
    report.wavDuration = report.wavLoaded ? element.duration : 0
    if (report.wavLoaded && typeof element.setSinkId === 'function') {
      try {
        await element.setSinkId('')
        report.elementSinkApplied = true
      } catch (err) {
        report.elementSinkApplied = false
        report.elementSinkError = String(err && err.message ? err.message : err)
      }
    }
    if (report.wavLoaded) {
      try {
        await element.play()
        await wait(150)
        report.elementAdvanced = element.currentTime > 0
        report.elementTime = element.currentTime
        element.pause()
      } catch (err) {
        report.elementAdvanced = false
        report.elementError = String(err && err.message ? err.message : err)
      }
    }
    URL.revokeObjectURL(url)

    // 4b. The bundle's OWN tone engine, both routes, driven for real: the
    //     oscillator path (which is how a Chromium 110+ machine plays it) and the
    //     generated-WAV path (which is the one with the most moving parts).
    const toneErrors = []
    const engineRun = A.startTone({ strategy: 'context', frequency: 440, level: 25, channel: 'both', onError: (message) => toneErrors.push('tone: ' + message) })
    report.contextToneOk = engineRun.ok === true
    if (engineRun.ok) {
      await wait(150)
      engineRun.handle.stop()
    } else {
      toneErrors.push(String(engineRun.message))
    }
    const elementRun = A.startTone({ strategy: 'element', frequency: 880, level: 25, channel: 'right', onError: (message) => toneErrors.push('element: ' + message) })
    report.elementToneOk = elementRun.ok === true
    if (elementRun.ok) {
      await wait(300)
      elementRun.handle.stop()
    } else {
      toneErrors.push(String(elementRun.message))
    }
    report.toneErrors = toneErrors

    // 5. The meter: a real analyser on the real capture, read through the
    //    package's own arithmetic. The analyser is a SINK and is never connected
    //    to the destination, which is what keeps a room from feeding back.
    if (stream !== null) {
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      let frames = 0
      for (let step = 0; step < 12; step += 1) {
        await wait(60)
        analyser.getByteTimeDomainData(data)
        const level = A.rmsOfWaveform(data)
        if (level > 0) frames += 1
        report.rms = level
        report.bar = A.levelBar(level)
      }
      report.meterFrames = frames
      report.meterRows = A.describeStream(stream.getAudioTracks()[0])
      for (const track of stream.getTracks()) track.stop()
    }

    // 6. The remembered choice, in the browser's OWN storage.
    A.writeChoice(window.localStorage, { outputId: 'spk-check', inputId: 'mic-check' })
    report.stored = A.readChoice(window.localStorage)

    report.ms = Date.now() - started
    report.ok = true
    log('finished in ' + report.ms + 'ms')
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err))
    log('FAILED: ' + report.errors.join(' | '))
  }
  await post(report)
})()
window.addEventListener('error', (event) => { fetch('/report', { method: 'POST', body: JSON.stringify({ ok: false, errors: ['window error: ' + event.message] }) }).catch(() => {}) })
</script>
</body></html>`

  // -------------------------------------------------------------------------
  // The loopback server: this page, and the package's own bundle byte for byte
  // -------------------------------------------------------------------------
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-audio-browser-'))
  let reported = null
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/report') {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          try {
            reported = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (err) {
            reported = { ok: false, errors: ['the report was not JSON: ' + String(err && err.message)] }
          }
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('ok')
        })
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(PAGE)
        return
      }
      if (url.pathname === '/bundle.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        response.end(bundleSource)
        return
      }
      response.writeHead(404)
      response.end('no')
    } catch (err) {
      response.writeHead(500)
      response.end(String(err && err.message ? err.message : err))
    }
  })

  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const pageUrl = 'http://127.0.0.1:' + port + '/'
  const profile = path.join(sandbox, 'profile')

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--user-data-dir=' + profile,
      '--window-size=1000,700',
      // A headless browser has no microphone and no click, so the two flags that
      // give it one of each are what let this check run unattended. They are the
      // standard automation flags: nothing here is relaxed for the feature.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      pageUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let browserOutput = ''
  child.stdout.on('data', (chunk) => {
    browserOutput += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    browserOutput += chunk.toString()
  })

  const deadline = Date.now() + 90_000
  while (reported === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    child.kill()
  } catch (err) {
    /* already gone */
  }
  // Wait for it to actually exit before touching its profile: a killed Chrome
  // still holds its `Default/` files for a moment, and deleting a live profile is
  // an EBUSY, not a failure of anything this check is about.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  server.close()

  console.log('')
  if (reported === null) {
    check('the page reported its results', false, true)
    console.log('     the browser said:')
    console.log(browserOutput.split('\n').slice(0, 20).map((line) => '       ' + line).join('\n'))
  } else {
    for (const error of reported.errors ?? []) console.log('     page error: ' + error)
    check('the bundle loads in a real browser and exposes its half', reported.bundleId === 'dsh-audio' && (reported.internals ?? 0) > 20)
    // The verdict must FOLLOW the prototypes the browser actually has, on any
    // host: an older Chromium is a `element` host and Firefox is a `none` host,
    // and both are correct answers.
    check(
      'the routing verdict follows the prototypes this browser has',
      reported.routingKind,
      reported.contextSetSinkId === true ? 'context' : reported.elementSetSinkId === true ? 'element' : 'none',
    )
    console.log('     this browser: AudioContext.setSinkId ' + String(reported.contextSetSinkId) + ', HTMLMediaElement.setSinkId ' + String(reported.elementSetSinkId))
    console.log('     the verdict: ' + String(reported.routingKind) + ' — ' + String(reported.routingSentence ?? ''))
    check('a real AudioContext really runs', reported.contextState, 'running')
    check('it reports its own rate', (reported.sampleRate ?? 0) > 0, true)
    if (reported.contextSetSinkId === true) {
      check('setSinkId really moves the engine', reported.sinkApplied, true)
      if (reported.sinkApplied !== true) console.log('     setSinkId said: ' + String(reported.sinkError ?? ''))
    }
    // The device list, out of the browser rather than out of a fixture.
    check('the browser hands over a device list this package can read', Array.isArray(reported.devices?.kinds))
    console.log(
      '     devices: ' +
        String(reported.devices?.outputs ?? 0) +
        ' output(s), ' +
        String(reported.devices?.inputs ?? 0) +
        ' input(s), unnamed=' +
        String(reported.devices?.unnamed) +
        ', default -> ' +
        (reported.defaultTarget === '' ? '(not stated)' : String(reported.defaultTarget)),
    )
    if (typeof reported.micError === 'string' && reported.micError !== '') {
      console.log('skip the capture-derived checks                          (no microphone for this browser: ' + reported.micError + ')')
    } else {
      check('the capture we opened is IN the list', (reported.devices?.inputs ?? 0) >= 1, true)
      check('...and the labels appear once the page may capture', reported.devices?.unnamed, false)
      check('the meter reads a real analyser frame through the bundle', Number.isFinite(reported.rms) && (reported.bar ?? -1) >= 0 && (reported.bar ?? 2) <= 1, true)
      console.log('     the last frame: ' + Number(reported.rms).toFixed(5) + ' rms, bar ' + Number(reported.bar).toFixed(3) + ', frames above zero ' + String(reported.meterFrames ?? 0) + '/12')
      check('the captured track describes itself', Array.isArray(reported.meterRows) && reported.meterRows.length > 0, true)
      if (Array.isArray(reported.meterRows) && reported.meterRows.length > 0) {
        console.log('     the track: ' + reported.meterRows.map((row) => row[0] + '=' + row[1]).join(', '))
      }
    }
    // THE ENCODER, against a real decoder in a real browser: this is the one
    // claim a Node check cannot make, because Node has no media pipeline.
    check('the bundle\u2019s own WAV encoder produced a file the browser PLAYS', reported.wavLoaded, true)
    check('...and its duration is the one the samples state', Math.abs((reported.wavDuration ?? 0) - 0.25) < 0.06, true)
    console.log('     the generated tone: ' + String(reported.wavBytes ?? 0) + ' bytes, ' + Number(reported.wavDuration ?? 0).toFixed(3) + 's')
    if (reported.elementSetSinkId === true) {
      check('a media element really takes a sink too', reported.elementSinkApplied, true)
      if (reported.elementSinkApplied !== true) console.log('     the element said: ' + String(reported.elementSinkError ?? ''))
    }
    check('...and it really plays', reported.elementAdvanced, true)
    if (reported.elementAdvanced !== true) console.log('     playback said: ' + String(reported.elementError ?? '(no error reported)'))
    // The package's OWN tone engine, both routes, in a real browser.
    check('the bundle\u2019s own tone engine starts on the audio engine', reported.contextToneOk, true)
    check('...and the generated-WAV route starts too', reported.elementToneOk, true)
    check('no tone route reported an error', (reported.toneErrors ?? []).length, 0)
    if ((reported.toneErrors ?? []).length > 0) console.log('     the tone said: ' + reported.toneErrors.join(' | '))
    check('the remembered pick survives the browser\u2019s own storage', reported.stored?.outputId === 'spk-check' && reported.stored?.inputId === 'mic-check')
    console.log('     the page finished in ' + String(reported.ms ?? 0) + 'ms')
  }

  if (!keep) {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (err) {
      console.log('note: could not remove ' + sandbox + ' (' + (err && err.code ? err.code : 'error') + ') - delete it by hand')
    }
  }

  console.log('')
  console.log(failures === 0 ? 'all audio browser checks passed' : failures + ' audio browser check(s) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
}
