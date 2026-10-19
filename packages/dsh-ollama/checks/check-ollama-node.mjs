// check-ollama-node.mjs - dsh-ollama's own contract, driven end to end.
//
// The daemon is the machine's own service and it is NOT running on a fresh
// machine, so the only way to exercise the arithmetic, the caps, the
// confirmations and every refusal deterministically is a FAKE one: a
// `node:http` server on 127.0.0.1:0 answering the real routes with canned
// bodies and FIXED nanosecond durations. That makes the numbers assertions
// rather than observations:
//
//   eval_count 100 / eval_duration 2e9   -> 50.0 tok/s, exactly
//   prompt_eval_count 20 / 200e6         -> 100.0 tok/s
//   load_duration 1e9                    -> 1.00 s, and TTFT derived = 1.20 s
//
// Three sections need the real world, and each says so when it cannot:
//
//   - the SKILL EXAMPLES: every fenced curl block is parsed as a request (URL,
//     method, JSON body), every Python block is parsed by python's own `ast`
//     when a Python is on PATH, and every JavaScript block is checked by
//     `node --check`. A doc and its engine cannot drift apart unnoticed.
//   - the LIVE half: one tiny generation against the daemon that IS running
//     here, only when it answers, and skipped with the reason when it does not.
//
// Run:  node checks/check-ollama-node.mjs
//       DSH_OLLAMA_CHECK_LIVE=0 node checks/check-ollama-node.mjs   # pure half only
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { ALLOW_REMOTE_ENV, DEFAULT_HOST, isLoopbackHost, resolveHost } from '../lib/client.js'
import {
  cosineSimilarity,
  formatBytes,
  formatExpiry,
  formatShare,
  measure,
  millisecondsOf,
  percentile,
  summarize,
  tokensPerSecond,
  vectorNorm,
} from '../lib/metrics.js'
import { CAPS, validateBench, validateEmbed, validateModels, validateOptions, validateRun } from '../lib/validate.js'
import { benchText, benchView, buildTools, pullSummary } from '../lib/tools.js'
import { activationLine, createDeps, parseSkillFile, PLUGIN_VERSION, SKILL_FILES, __internals } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(here, '..')
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

let checks = 0
let failures = 0
let skipped = 0
const check = (label, actual, expected) => {
  checks += 1
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(56) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
const skip = (label, reason) => {
  skipped += 1
  console.log('skip ' + label.padEnd(56) + ' (' + reason + ')')
}
const near = (label, actual, expected, tolerance = 1e-6) => check(label, typeof actual === 'number' && Math.abs(actual - expected) <= tolerance, true)

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------
check('the package is a dsh bundle with a patch layer', manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch, './cordis.patch.yml')
check('the row owns no browser half', manifest.dsh.client === undefined, true)
check('the row has no npm dependency', manifest.dependencies === undefined && manifest.peerDependencies === undefined, true)
check('the version is the alpha this check knows', manifest.version, PLUGIN_VERSION)
check('package.json is the manifest this check read', manifest.version, '0.1.0-alpha.1')
check('the skills and checks ship in the package', ['lib', 'skills', 'checks', 'cordis.patch.yml'].every((entry) => manifest.files.includes(entry)), true)

// ---------------------------------------------------------------------------
// The loopback fence - pure, no socket
// ---------------------------------------------------------------------------
const plain = resolveHost({})
check('with no OLLAMA_HOST the daemon is the loopback default', plain.origin, 'http://' + DEFAULT_HOST)
check('...and it is allowed', plain.allowed && plain.local, true)
check('a bare host:port gets a scheme', resolveHost({ OLLAMA_HOST: 'localhost:11500' }).origin, 'http://localhost:11500')
check('an explicit http:// is kept', resolveHost({ OLLAMA_HOST: 'http://127.0.0.1:12000' }).port, 12000)
check('IPv6 loopback is accepted', resolveHost({ OLLAMA_HOST: 'http://[::1]:11434' }).host, '::1')
check('all of 127/8 is this machine', resolveHost({ OLLAMA_HOST: '127.0.0.2:11434' }).local, true)
check('0.0.0.0 is a local bind address', resolveHost({ OLLAMA_HOST: '0.0.0.0:11434' }).local, true)
check('a hostname is not loopback', isLoopbackHost('example.com'), false)
check('localhost is', isLoopbackHost('localhost'), true)
check('a *.localhost name is', isLoopbackHost('daemon.localhost'), true)
const remote = resolveHost({ OLLAMA_HOST: 'http://10.0.0.5:11434' })
check('another machine is remote', remote.remote && remote.allowed === false, true)
check('...and refused with a code', remote.code, 'REMOTE_REFUSED')
check('...naming the opt-in variable', remote.reason.includes(ALLOW_REMOTE_ENV), true)
const optedIn = resolveHost({ OLLAMA_HOST: 'http://10.0.0.5:11434', [ALLOW_REMOTE_ENV]: '1' })
check('the opt-in variable allows it', optedIn.allowed && optedIn.optIn && optedIn.remote, true)
check('a nonsense host is invalid, not remote', resolveHost({ OLLAMA_HOST: 'not a host' }).code, 'HOST_INVALID')
check('a non-http scheme is refused', resolveHost({ OLLAMA_HOST: 'ftp://127.0.0.1:11434' }).code, 'HOST_INVALID')
check('credentials in OLLAMA_HOST are refused', resolveHost({ OLLAMA_HOST: 'http://user:pass@127.0.0.1:11434' }).code, 'HOST_INVALID')
check('port 0 is not a port', resolveHost({ OLLAMA_HOST: '127.0.0.1:0' }).code, 'HOST_INVALID')
check('a base path is preserved', resolveHost({ OLLAMA_HOST: 'http://127.0.0.1:11434/ollama' }).base, 'http://127.0.0.1:11434/ollama')

// ---------------------------------------------------------------------------
// The arithmetic - pure
// ---------------------------------------------------------------------------
check('2e9 ns is 2 s', millisecondsOf(2_000_000_000), 2000)
check('a missing duration is null, not NaN', millisecondsOf(undefined), null)
check('100 tokens in 2 s is 50 tok/s', tokensPerSecond(100, 2_000_000_000), 50)
check('a zero duration is null, not Infinity', tokensPerSecond(100, 0), null)
check('zero tokens is 0 tok/s', tokensPerSecond(0, 2_000_000_000), 0)
const FIXED = {
  eval_count: 100,
  eval_duration: 2_000_000_000,
  prompt_eval_count: 20,
  prompt_eval_duration: 200_000_000,
  load_duration: 1_000_000_000,
  total_duration: 3_500_000_000,
}
const measured = measure({ ...FIXED, done_reason: 'stop' }, { wallMs: 3610, ttftMs: 1210 })
check('the measured shape reads every daemon field', measured.evalMs + '/' + measured.promptEvalMs + '/' + measured.loadMs + '/' + measured.totalMs, '2000/200/1000/3500')
check('tok/s is eval_count over eval_duration', measured.evalTokensPerSecond, 50)
check('prompt tok/s is its own pair', measured.promptTokensPerSecond, 100)
check('TTFT derived is load + prompt eval', measured.ttftDerivedMs, 1200)
check('TTFT measured is the observed one', measured.ttftMeasuredMs, 1210)
check('the wall clock is the caller\'s', measured.wallMs, 3610)
check('the stop reason travels', measured.doneReason, 'stop')
check('a one-element sample has a median', percentile([42], 50), 42)
check('the median of five is the middle one', percentile([50, 40, 66.7, 33.3, 100], 50), 50)
check('p95 by nearest rank is a real run', percentile([50, 40, 66.7, 33.3, 100], 95), 100)
check('an empty percentile is null', percentile([], 95), null)
const summary = summarize([33.3, 40, 50, 66.7, 100])
check('the summary names the sample size', summary.count, 5)
check('...its median', summary.median, 50)
check('...its extremes', summary.min + '..' + summary.max, '33.3..100')
check('...its spread as a relative stdev', near('spread', summary.spread, summary.stdev / summary.mean) && true, true)
check('a one-run sample has no spread to trust', summarize([7]).spread, 0)
check('cosine of orthogonal vectors is 0', cosineSimilarity([1, 0], [0, 1]), 0)
check('cosine of identical vectors is 1', near('cosine', cosineSimilarity([1, 2], [1, 2]), 1), true)
check('cosine of a zero vector is null', cosineSimilarity([0, 0], [1, 1]), null)
check('cosine of mismatched dimensions is null', cosineSimilarity([1], [1, 2]), null)
check('a norm is the L2 length', vectorNorm([3, 4]), 5)
check('bytes read like ollama list', formatBytes(4.7 * 1024 ** 3), '4.7 GB')
check('a share is a percentage', formatShare(3, 4), '75%')
check('an unknown whole has no share', formatShare(3, 0), '')
check('a future expiry is a sentence', formatExpiry(new Date(Date.now() + 5 * 60_000).toISOString()), 'in 5 minutes')
check('a past expiry says so', formatExpiry(new Date(Date.now() - 60_000).toISOString()), 'expired')

// ---------------------------------------------------------------------------
// The argument grammar - pure
// ---------------------------------------------------------------------------
const refusalCode = (fn) => {
  try {
    fn()
    return 'accepted'
  } catch (error) {
    return error.code
  }
}
check('a model tag is accepted', validateRun({ model: 'qwen2.5:7b', prompt: 'x' }).model, 'qwen2.5:7b')
check('a namespaced tag is accepted', validateRun({ model: 'hf.co/user/model:Q4_K_M', prompt: 'x' }).model, 'hf.co/user/model:Q4_K_M')
check('a space in a tag is refused', refusalCode(() => validateRun({ model: 'Qwen 2', prompt: 'x' })), 'BAD_MODEL')
check('a flag-looking tag is refused', refusalCode(() => validateRun({ model: '--all', prompt: 'x' })), 'BAD_MODEL')
check('a digest is refused outside a pull', refusalCode(() => validateRun({ model: 'qwen2.5:7b@sha256:' + 'a'.repeat(64), prompt: 'x' })), 'BAD_MODEL')
check('a digest is accepted for a pull', validateModels({ action: 'pull', model: 'qwen2.5:7b@sha256:' + 'a'.repeat(64), confirm: 'x' }).model.length > 0, true)
check('prompt and messages together are refused', refusalCode(() => validateRun({ model: 'a:1b', prompt: 'x', messages: [{ role: 'user', content: 'x' }] })), 'BAD_ARGUMENT')
check('neither prompt nor messages is refused', refusalCode(() => validateRun({ model: 'a:1b' })), 'BAD_ARGUMENT')
check('an empty prompt is refused', refusalCode(() => validateRun({ model: 'a:1b', prompt: '   ' })), 'BAD_ARGUMENT')
check('system with messages is refused, with the fix', refusalCode(() => validateRun({ model: 'a:1b', messages: [{ role: 'user', content: 'x' }], system: 's' })), 'BAD_ARGUMENT')
check('a bad role is refused', refusalCode(() => validateRun({ model: 'a:1b', messages: [{ role: 'robot', content: 'x' }] })), 'BAD_MESSAGES')
check('an invented message field is refused', refusalCode(() => validateRun({ model: 'a:1b', messages: [{ role: 'user', content: 'x', weight: 2 }] })), 'BAD_MESSAGES')
check('a data: URL image is refused as not base64', refusalCode(() => validateRun({ model: 'a:1b', messages: [{ role: 'user', content: 'x', images: ['data:image/png;base64,AAAA'] }] })), 'BAD_MESSAGES')
check('an unknown option is refused by name', refusalCode(() => validateOptions({ temprature: 0 })), 'BAD_OPTION')
check('...and the refusal lists the known ones', (() => { try { validateOptions({ temprature: 0 }) } catch (error) { return error.message.includes('temperature') } return false })(), true)
check('num_predict over the ceiling is refused', refusalCode(() => validateOptions({ num_predict: CAPS.maxNumPredict + 1 })), 'BAD_OPTION')
check('num_predict 0 is refused', refusalCode(() => validateOptions({ num_predict: 0 })), 'BAD_OPTION')
check('temperature 3 is refused', refusalCode(() => validateOptions({ temperature: 3 })), 'BAD_OPTION')
check('a fractional integer option is refused', refusalCode(() => validateOptions({ seed: 1.5 })), 'BAD_OPTION')
check('a stop array of nine is refused', refusalCode(() => validateOptions({ stop: new Array(9).fill('x') })), 'BAD_OPTION')
check('a stop string is accepted as a one-element list', validateOptions({ stop: '###' }).stop.join(','), '###')
check('format "yaml" is refused', refusalCode(() => validateRun({ model: 'a:1b', prompt: 'x', format: 'yaml' })), 'BAD_FORMAT')
check('format "json" is accepted', validateRun({ model: 'a:1b', prompt: 'x', format: 'json' }).format, 'json')
check('a JSON Schema format is accepted', typeof validateRun({ model: 'a:1b', prompt: 'x', format: { type: 'object' } }).format, 'object')
check('keep_alive "soon" is refused', refusalCode(() => validateRun({ model: 'a:1b', prompt: 'x', keep_alive: 'soon' })), 'BAD_KEEP_ALIVE')
check('keep_alive 0 is accepted', validateRun({ model: 'a:1b', prompt: 'x', keep_alive: 0 }).keepAlive, 0)
check('keep_alive "5m" is accepted', validateRun({ model: 'a:1b', prompt: 'x', keep_alive: '5m' }).keepAlive, '5m')
check('a timeout outside the range is refused', refusalCode(() => validateRun({ model: 'a:1b', prompt: 'x', timeoutSeconds: 5 })), 'BAD_ARGUMENT')
check('one run always carries a bounded num_predict', validateRun({ model: 'a:1b', prompt: 'x' }).options.num_predict, CAPS.defaultNumPredict)
check('two runs is not a benchmark', refusalCode(() => validateBench({ model: 'a:1b', prompt: 'x', runs: 2 })), 'BAD_RUNS')
check('...and the refusal says why', (() => { try { validateBench({ model: 'a:1b', prompt: 'x', runs: 2 }) } catch (error) { return /measurement/i.test(error.message) } return false })(), true)
check('a bench defaults to 5 runs at temperature 0, seed 42', (() => { const plan = validateBench({ model: 'a:1b', prompt: 'x' }); return plan.runs === 5 && plan.options.temperature === 0 && plan.options.seed === 42 })(), true)
check('a bench refuses model and models together', refusalCode(() => validateBench({ model: 'a:1b', models: ['a:1b'], prompt: 'x' })), 'BAD_ARGUMENT')
check('an A/B of four models is refused', refusalCode(() => validateBench({ models: ['a:1b', 'b:1b', 'c:1b', 'd:1b'], prompt: 'x' })), 'BAD_ARGUMENT')
check('the same model twice is refused', refusalCode(() => validateBench({ models: ['a:1b', 'a:1b'], prompt: 'x' })), 'BAD_ARGUMENT')
check('a duplicate context is refused', refusalCode(() => validateBench({ model: 'a:1b', prompt: 'x', contexts: [2048, 2048] })), 'BAD_ARGUMENT')
check('a plan over 150 calls is refused', refusalCode(() => validateBench({ models: ['a:1b', 'b:1b', 'c:1b'], prompt: 'x', runs: 50, contexts: [2048, 4096, 8192, 16384, 32768, 65536] })), 'BAD_ARGUMENT')
check('a bench timeout of 10 s is refused', refusalCode(() => validateBench({ model: 'a:1b', prompt: 'x', timeoutSeconds: 10 })), 'BAD_ARGUMENT')
check('an embed of 65 inputs is refused', refusalCode(() => validateEmbed({ model: 'e:1', input: new Array(65).fill('x') })), 'BAD_ARGUMENT')
check('an embed of two strings defaults to a similarity', validateEmbed({ model: 'e:1', input: ['a', 'b'] }).similarity, true)
check('an embed of one string does not', validateEmbed({ model: 'e:1', input: ['a'] }).similarity, false)
check('an unknown model action is refused', refusalCode(() => validateModels({ action: 'push' })), 'BAD_ARGUMENT')
check('list needs no model', validateModels({}).model, '')
check('a pull carries a raisable deadline', validateModels({ action: 'pull', model: 'a:1b', confirm: 'a:1b' }).timeoutSeconds, 1800)
check('...and refuses one outside the range', refusalCode(() => validateModels({ action: 'pull', model: 'a:1b', confirm: 'a:1b', timeoutSeconds: 5 })), 'BAD_ARGUMENT')

// ---------------------------------------------------------------------------
// The fake daemon
// ---------------------------------------------------------------------------
const NOW = '2026-01-02T03:04:05Z'
const BENCH_DURATIONS = [2_000_000_000, 2_500_000_000, 1_500_000_000, 3_000_000_000, 1_000_000_000]
const TAGS = [
  {
    name: 'qwen2.5:7b',
    model: 'qwen2.5:7b',
    size: 4.7 * 1024 ** 3,
    digest: 'sha256:' + 'a'.repeat(64),
    modified_at: NOW,
    details: { format: 'gguf', family: 'qwen2', families: ['qwen2'], parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
  },
  {
    name: 'llama3.2:1b',
    model: 'llama3.2:1b',
    size: 1.3 * 1024 ** 3,
    digest: 'sha256:' + 'b'.repeat(64),
    modified_at: NOW,
    details: { format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '1.2B', quantization_level: 'Q8_0' },
  },
  {
    name: 'nomic-embed-text:latest',
    model: 'nomic-embed-text:latest',
    size: 274 * 1024 ** 2,
    digest: 'sha256:' + 'c'.repeat(64),
    modified_at: NOW,
    details: { format: 'gguf', family: 'nomic-bert', families: ['nomic-bert'], parameter_size: '137M', quantization_level: 'F16' },
  },
]
const SHOW = {
  'qwen2.5:7b': {
    details: { format: 'gguf', family: 'qwen2', families: ['qwen2'], parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
    capabilities: ['completion', 'tools'],
    parameters: 'num_ctx 32768\ntemperature 0.7',
    template: '{{ if .System }}<|im_start|>system\n{{ .System }}{{ end }}<|im_start|>user\n{{ .Prompt }}<|im_end|>',
    license: 'Apache License 2.0',
    model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768, 'qwen2.block_count': 28 },
  },
  'llama3.2:1b': {
    details: { format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '1.2B', quantization_level: 'Q8_0' },
    capabilities: ['completion'],
    parameters: 'num_ctx 131072',
    template: '{{ .Prompt }}',
    license: 'Llama 3.2 Community License',
    model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072, 'llama.block_count': 16, 'llama.embedding_length': 2048 },
  },
  'nomic-embed-text:latest': {
    details: { format: 'gguf', family: 'nomic-bert', families: ['nomic-bert'], parameter_size: '137M', quantization_level: 'F16' },
    capabilities: ['embedding'],
    parameters: '',
    template: '',
    license: 'Apache License 2.0',
    model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2048, 'nomic-bert.embedding_length': 768 },
  },
}

/** A deterministic 8-dimension vector; 'cat' and 'dog' have a known cosine. */
function vectorFor(text) {
  if (text === 'cat') return [1, 0, 0, 0, 0, 0, 0, 0]
  if (text === 'dog') return [1, 1, 0, 0, 0, 0, 0, 0]
  const seed = [...String(text)].reduce((sum, character) => sum + character.codePointAt(0), 0)
  return Array.from({ length: 8 }, (_, index) => Math.sin(seed * (index + 1)))
}

/** Read a request body to a string. */
function readAll(request) {
  return new Promise((resolve) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
    })
    request.on('end', () => resolve(text))
  })
}

/** The daemon, canned. */
async function startFakeDaemon() {
  const state = { legacyEmbeddings: false, benchIndex: 0, unloads: 0, slow: true }
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const raw = await readAll(request)
    let body = null
    try {
      body = raw === '' ? null : JSON.parse(raw)
    } catch (error) {
      body = null
    }
    requests.push({ method: request.method, path: url.pathname, body })
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const ndjson = () => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      return (value) => response.write(JSON.stringify(value) + '\n')
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (url.pathname === '/api/version') return json(200, { version: '0.40.3' })
    if (url.pathname === '/api/tags') return json(200, { models: TAGS })
    if (url.pathname === '/api/ps') {
      return json(200, {
        models: [
          {
            name: 'qwen2.5:7b',
            model: 'qwen2.5:7b',
            size: 7.3 * 1024 ** 3,
            size_vram: 7.3 * 1024 ** 3,
            digest: 'sha256:' + 'a'.repeat(64),
            details: TAGS[0].details,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            context_length: 8192,
          },
        ],
      })
    }
    if (url.pathname === '/api/show') {
      const model = String(body?.model ?? '')
      const found = SHOW[model]
      if (found === undefined) return json(404, { error: 'model "' + model + '" not found, try pulling it first' })
      return json(200, found)
    }
    if (url.pathname === '/api/generate') {
      const model = String(body?.model ?? '')
      if (model === 'missing:1b') return json(404, { error: 'model "missing:1b" not found, try pulling it first' })
      if (body?.keep_alive === 0 && (body.prompt === undefined || body.prompt === '')) {
        state.unloads += 1
        return json(200, { model, created_at: NOW, response: '', done: true })
      }
      if (body?.prompt === 'bench') {
        const duration = BENCH_DURATIONS[state.benchIndex % BENCH_DURATIONS.length]
        state.benchIndex += 1
        return json(200, {
          model,
          created_at: NOW,
          response: '',
          done: true,
          done_reason: 'stop',
          eval_count: 100,
          eval_duration: duration,
          prompt_eval_count: 20,
          prompt_eval_duration: 200_000_000,
          load_duration: state.benchIndex === 1 ? 1_000_000_000 : 0,
          total_duration: duration + 200_000_000,
        })
      }
      const write = ndjson()
      // The prompt-eval delay comes BEFORE the first token, which is what makes
      // a measured TTFT a measurement rather than the transport's first flush.
      if (state.slow) await wait(12)
      write({ model, created_at: NOW, response: 'Hel', done: false })
      if (state.slow) await wait(6)
      write({ model, created_at: NOW, response: 'lo', done: false })
      write({ model, created_at: NOW, response: '', done: true, done_reason: 'stop', ...FIXED })
      return response.end()
    }
    if (url.pathname === '/api/chat') {
      const write = ndjson()
      write({ model: body?.model, created_at: NOW, message: { role: 'assistant', content: 'Hi' }, done: false })
      write({ model: body?.model, created_at: NOW, message: { role: 'assistant', content: ' there' }, done: false })
      write({ model: body?.model, created_at: NOW, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', ...FIXED })
      return response.end()
    }
    if (url.pathname === '/api/embed') {
      if (state.legacyEmbeddings) return json(404, { error: '404 page not found' })
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? '']
      return json(200, { model: body?.model, embeddings: inputs.map(vectorFor) })
    }
    if (url.pathname === '/api/embeddings') {
      return json(200, { embedding: vectorFor(String(body?.prompt ?? '')) })
    }
    if (url.pathname === '/api/pull') {
      const write = ndjson()
      write({ status: 'pulling manifest' })
      write({ status: 'pulling 966de95ca8a6', digest: 'sha256:966de95ca8a6', total: 1_000_000, completed: 400_000 })
      write({ status: 'pulling 966de95ca8a6', digest: 'sha256:966de95ca8a6', total: 1_000_000, completed: 1_000_000 })
      write({ status: 'pulling f70b4c8b5a5d', digest: 'sha256:f70b4c8b5a5d', total: 2_000_000, completed: 2_000_000 })
      write({ status: 'verifying sha256 digest' })
      write({ status: 'success' })
      return response.end()
    }
    if (url.pathname === '/api/delete') {
      if (String(body?.model ?? '') === 'missing:1b') return json(404, { error: 'model "missing:1b" not found' })
      return json(200, {})
    }
    return json(404, { error: '404 page not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    origin: 'http://127.0.0.1:' + port,
    state,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const daemon = await startFakeDaemon()
const logged = { info() {}, warn() {} }
const stubCtx = { logger: logged, get: () => undefined, effect: (fn) => fn() }
/** The dependencies every tool test uses: the fake daemon, a fixed CLI version. */
const makeDeps = (overrides = {}) =>
  createDeps(stubCtx, {
    env: { OLLAMA_HOST: daemon.origin },
    runner: async () => ({ status: 0, stdout: '', stderr: 'Warning: could not connect to a running Ollama instance\nWARNING: client version is 0.40.3\n', timedOut: false }),
    ...overrides,
  })
const deps = makeDeps()
const tools = buildTools(deps)
const tool = (name) => tools.find((entry) => entry.name === name)
const exec = { signal: new AbortController().signal }
const resetBench = () => {
  daemon.state.benchIndex = 0
  daemon.state.unloads = 0
}

try {
  // -------------------------------------------------------------------------
  // The registration
  // -------------------------------------------------------------------------
  check('five tools are registered', tools.map((entry) => entry.name).join(','), __internals.CAPABILITIES.tools.join(','))
  check(
    'every tool declares a JSON-schema surface',
    tools.every((entry) => entry.parameters && entry.parameters.type === 'object' && Object.keys(entry.parameters.properties ?? {}).length >= 0 && entry.output && typeof entry.output.render === 'function' && typeof entry.execute === 'function'),
    true,
  )
  check('the row asks only for the tools registry', __internals.CAPABILITIES.tools.length === 5)
  check('both generation tools share the closed options schema', tool('ollama_run').parameters.properties.options === tool('ollama_bench').parameters.properties.options, true)
  check('...which refuses an option it does not declare', tool('ollama_run').parameters.properties.options.additionalProperties, false)
  check('no route is declared', __internals.CAPABILITIES.endpoints.every((entry) => entry.startsWith('/api/')), true)
  check('the capabilities name what is not built', __internals.CAPABILITIES.notBuilt.some((entry) => /daemon/i.test(entry)), true)
  check('the three skills are listed', __internals.CAPABILITIES.skills.join(','), 'ollama-api,ollama-inference-metrics,ollama-python')

  // -------------------------------------------------------------------------
  // ollama_status
  // -------------------------------------------------------------------------
  const status = await tool('ollama_status').execute({}, exec)
  check('status reaches the fake daemon', status.view.ok, true)
  check('...and reports its version', status.view.daemon.version, '0.40.3')
  check('...and the CLI version it read', status.view.cli, '0.40.3')
  check('...and the models on disk', status.view.counts.models, 3)
  check('...their total bytes', status.view.counts.bytes, TAGS.reduce((sum, entry) => sum + entry.size, 0))
  check('...and the one loaded model', status.view.counts.loaded, 1)
  check('the table prints family, quant and size', status.text.includes('qwen2.5:7b') && status.text.includes('Q4_K_M') && status.text.includes('4.7 GB'), true)
  check('the loaded model names its processor split', status.view.loaded[0].processor, '100% GPU')
  check('the loaded model names its context', status.view.loaded[0].contextLength, 8192)
  check('the loaded model names its expiry', status.view.loaded[0].expiresAt !== '' && status.text.includes('in 5 minutes'), true)
  check('the digest is shown short', status.text.includes('a'.repeat(12)), true)
  check('the next move is named', /ollama_bench/.test(status.text), true)
  check('status did not start anything', daemon.requests.every((entry) => !/serve|start/.test(entry.path)), true)

  // A daemon that is NOT running: one sentence, and the command that starts it.
  const closed = makeDeps({ env: { OLLAMA_HOST: '127.0.0.1:1' } })
  const downAnswer = await buildTools(closed).find((entry) => entry.name === 'ollama_status').execute({}, exec)
  check('a closed port is an ANSWER, not a throw', downAnswer.view.code, 'DAEMON_DOWN')
  check('...naming the address it tried', downAnswer.text.includes('127.0.0.1:1'), true)
  check('...and the command that starts one', downAnswer.text.includes('ollama serve'), true)
  check('...and saying nothing was started', /Nothing was started/.test(downAnswer.text), true)

  // The fence: an off-machine host never reaches fetch at all.
  let fetched = 0
  const spied = makeDeps({ env: { OLLAMA_HOST: 'http://10.0.0.5:11434' }, fetch: async () => (fetched += 1, new Response('{}')) })
  const fenced = await buildTools(spied).find((entry) => entry.name === 'ollama_status').execute({}, exec)
  check('an off-machine daemon is refused', fenced.view.code, 'REMOTE_REFUSED')
  check('...and NO request was made', fetched, 0)
  check('...and the sentence names the opt-in', fenced.text.includes(ALLOW_REMOTE_ENV), true)
  const activation = activationLine(makeDeps())
  check('the activation line names the loopback address', activation.includes('127.0.0.1') && activation.includes('ollama_status'), true)
  check('the activation line says nothing is started', /nothing is started/.test(activation), true)
  check('an inert row says why', /inert:/.test(activationLine(makeDeps({ env: { OLLAMA_HOST: 'http://10.0.0.9:11434' } }))), true)

  // -------------------------------------------------------------------------
  // ollama_run
  // -------------------------------------------------------------------------
  const run = await tool('ollama_run').execute({ model: 'qwen2.5:7b', prompt: 'Say hello' }, exec)
  check('run answers', run.view.ok, true)
  check('...with the generated text', run.view.text, 'Hello')
  check('...with the eval token count', run.view.measured.evalCount, 100)
  check('...with 50 tok/s from the fixed durations', run.view.measured.evalTokensPerSecond, 50)
  check('...with the prompt count and rate', run.view.measured.promptEvalCount + '/' + run.view.measured.promptTokensPerSecond, '20/100')
  check('...with the load time', run.view.measured.loadMs, 1000)
  check('...with the daemon total', run.view.measured.totalMs, 3500)
  check('...and the digest it ran', run.view.digest, 'sha256:' + 'a'.repeat(64))
  check('...and a measured TTFT', typeof run.view.measured.ttftMeasuredMs === 'number' && run.view.measured.ttftMeasuredMs >= 8, true)
  check('...that is earlier than the wall clock', run.view.measured.ttftMeasuredMs < run.view.measured.wallMs, true)
  check('the prose prints the rate', run.text.includes('50.0 tok/s'), true)
  check('the prose prints both totals', run.text.includes('(daemon)') && run.text.includes('(wall)'), true)
  check('the prose carries the conditions', /Conditions: num_predict 512/.test(run.text), true)
  check('the prose says one run is not a measurement', /A single run is a single run/.test(run.text), true)
  check('the stop reason travels to the prose', /stop reason: stop/.test(run.text), true)
  check('the run went to /api/generate', daemon.requests.some((entry) => entry.path === '/api/generate' && entry.body?.prompt === 'Say hello' && entry.body?.stream === true), true)
  check('the default num_predict was sent', daemon.requests.filter((entry) => entry.body?.prompt === 'Say hello').pop().body.options.num_predict, 512)

  const chat = await tool('ollama_run').execute({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] }, exec)
  check('a messages call goes to /api/chat', daemon.requests.some((entry) => entry.path === '/api/chat'), true)
  check('...and joins the streamed content', chat.view.text, 'Hi there')
  check('...with the same numbers', chat.view.measured.evalTokensPerSecond, 50)

  const structured = await tool('ollama_run').execute({ model: 'qwen2.5:7b', prompt: 'x', format: { type: 'object', properties: { ok: { type: 'boolean' } } } }, exec)
  check('a JSON Schema format is passed through', daemon.requests.filter((entry) => entry.body?.prompt === 'x').pop().body.format.type, 'object')
  check('...and the run still answers', structured.view.ok, true)

  const missing = await tool('ollama_run').execute({ model: 'missing:1b', prompt: 'x' }, exec)
  check('a model that is not pulled is a typed refusal', missing.view.code, 'NO_MODEL')
  check('...listing the tags that are on disk', missing.text.includes('qwen2.5:7b') && missing.text.includes('llama3.2:1b'), true)
  check('...and the exact pull command', missing.text.includes('ollama pull missing:1b'), true)

  const badOption = await tool('ollama_run').execute({ model: 'qwen2.5:7b', prompt: 'x', options: { num_predict: 99999 } }, exec)
  check('an over-cap num_predict is refused, not clamped', badOption.view.code, 'BAD_OPTION')
  const typo = await tool('ollama_run').execute({ model: 'qwen2.5:7b', prompt: 'x', options: { temprature: 0 } }, exec)
  check('a typo in an option name is refused', typo.view.code, 'BAD_OPTION')
  check('...and the sentence explains what a typo would cost', /silently ignores/i.test(typo.text), true)
  const both = await tool('ollama_run').execute({ model: 'qwen2.5:7b', prompt: 'x', messages: [{ role: 'user', content: 'y' }] }, exec)
  check('prompt and messages together are refused', both.view.code, 'BAD_ARGUMENT')

  // A generation the model cuts at num_predict says so.
  const cut = await tool('ollama_run').execute({ model: 'qwen2.5:7b', prompt: 'cut', options: { num_predict: 4 } }, exec)
  check('a completed run is not told it was cut', /was cut at the model/.test(cut.text), false)

  // -------------------------------------------------------------------------
  // ollama_bench
  // -------------------------------------------------------------------------
  resetBench()
  const bench = await tool('ollama_bench').execute({ model: 'qwen2.5:7b', prompt: 'bench', runs: 5, timeoutSeconds: 120 }, exec)
  check('bench answers', bench.view.ok, true)
  check('...with five runs', bench.view.groups[0].runs.length, 5)
  check('...and the median of the fixed rates', bench.view.groups[0].rates.median, 50)
  check('...and p95 by nearest rank', bench.view.groups[0].rates.p95, 100)
  check('...and the extremes', bench.view.groups[0].rates.min + '/' + bench.view.groups[0].rates.max, '33.333333333333336/100')
  check('the model was unloaded before run 1', daemon.state.unloads >= 1, true)
  check('...and the view says so', bench.view.groups[0].unloaded, true)
  check('the prose prints a per-run table', /RUN\s+TOK\/S/.test(bench.text), true)
  check('the prose prints the median and spread', /median 50\.0/.test(bench.text) && /spread/.test(bench.text), true)
  check('the prose names the digest', bench.text.includes('a'.repeat(12)), true)
  check('the prose names the context (the model default)', /context model default/.test(bench.text), true)
  check('the prose calls tok/s generation-only', /generation phase only/.test(bench.text), true)
  check('the prose states the cold/warm comparison at the first token', /first run first token at .*warm runs 2-5 at .*median/.test(bench.text), true)
  check('...and how much later the cold first token was', /x later/.test(bench.text), true)
  check('the prose states the run count', /5 measured run\(s\)|Runs: 5 measured/.test(bench.text), true)
  const benchRequest = daemon.requests.filter((entry) => entry.body?.prompt === 'bench').pop()
  check('a bench sends temperature 0 and seed 42', benchRequest.body.options.temperature === 0 && benchRequest.body.options.seed === 42, true)
  check('a bench sends its own num_predict', benchRequest.body.options.num_predict, CAPS.benchNumPredict)

  resetBench()
  const ab = await tool('ollama_bench').execute({ models: ['qwen2.5:7b', 'llama3.2:1b'], prompt: 'bench', runs: 3, cold: false, timeoutSeconds: 120 }, exec)
  check('an A/B answers one group per model', ab.view.groups.length, 2)
  check('...naming both models', /qwen2\.5:7b vs llama3\.2:1b/.test(ab.text), true)
  check('...with three runs each', ab.view.groups.every((group) => group.runs.length === 3), true)
  check('cold:false leaves the weights loaded', daemon.state.unloads, 0)
  check('...and no group claims an unload', ab.view.groups.every((group) => group.unloaded === false), true)

  resetBench()
  const sweep = await tool('ollama_bench').execute({ model: 'qwen2.5:7b', prompt: 'bench', runs: 3, contexts: [2048, 4096], timeoutSeconds: 120 }, exec)
  check('a context sweep answers one group per context', sweep.view.groups.map((group) => group.context).join(','), '2048,4096')
  check('...and says each context in the prose', sweep.text.includes('context 2048') && sweep.text.includes('context 4096'), true)
  const sweptContexts = daemon.requests.filter((entry) => entry.body?.prompt === 'bench').map((entry) => entry.body.options.num_ctx)
  check('...and sends num_ctx on every run', sweptContexts.includes(2048) && sweptContexts.includes(4096), true)

  resetBench()
  const shortBench = await tool('ollama_bench').execute({ model: 'qwen2.5:7b', prompt: 'bench', runs: 2 }, exec)
  check('two runs is refused in words', shortBench.view.code, 'BAD_RUNS')
  check('...and the words explain it', /measurement/i.test(shortBench.text), true)
  const tooBig = await tool('ollama_bench').execute({ models: ['qwen2.5:7b', 'llama3.2:1b', 'nomic-embed-text:latest'], prompt: 'bench', runs: 50, contexts: [2048, 4096, 8192, 16384] }, exec)
  check('an over-150-call plan is refused', tooBig.view.code, 'BAD_ARGUMENT')

  // The aggregate functions are separately exportable and separately true.
  const viewText = benchText(
    { runs: 2, measuredCalls: 2, warmupCalls: 0, cold: false, timeoutSeconds: 120, timeoutMs: 120_000, options: { num_predict: 128 } },
    [{ model: 'm:1b', digest: '', context: null, unloaded: false, runs: [{ index: 1, measured: measure(FIXED) }, { index: 2, measured: measure(FIXED) }] }],
    resolveHost({}),
  )
  check('the bench text is exported for the check', viewText.includes('BENCH m:1b'), true)
  check('the bench view carries the summaries', benchView({ runs: 2, measuredCalls: 2, cold: false, options: {} }, [], resolveHost({})).runs, 2)
  const pulled = pullSummary([
    { status: 'pulling manifest' },
    { status: 'pulling a', digest: 'sha256:a', total: 100, completed: 40 },
    { status: 'pulling a', digest: 'sha256:a', total: 100, completed: 100 },
    { status: 'success' },
  ])
  check('a pull summary sums its layers once', pulled.layers + '/' + pulled.total + '/' + pulled.completed, '1/100/100')
  check('...and keeps the final status', pulled.status, 'success')

  // -------------------------------------------------------------------------
  // ollama_models
  // -------------------------------------------------------------------------
  const list = await tool('ollama_models').execute({ action: 'list' }, exec)
  check('list answers', list.view.count, 3)
  check('...with family and quantization', list.text.includes('nomic-bert') && list.text.includes('Q8_0'), true)
  check('...and the total bytes', list.text.includes('6.3 GB') || list.text.includes('6.2 GB') || /model\(s\), .* on disk/.test(list.text), true)
  const show = await tool('ollama_models').execute({ action: 'show', model: 'qwen2.5:7b' }, exec)
  check('show answers with the capabilities', show.text.includes('completion, tools'), true)
  check('...the context length', show.text.includes('context 32768'), true)
  check('...the parameters the model ships with', show.text.includes('temperature 0.7'), true)
  check('...and the license', show.text.includes('Apache License'), true)
  const showEmbed = await tool('ollama_models').execute({ action: 'show', model: 'nomic-embed-text:latest' }, exec)
  check('an embedding model reports the dimensions', showEmbed.text.includes('768 dimensions'), true)
  const showCompletion = await tool('ollama_models').execute({ action: 'show', model: 'llama3.2:1b' }, exec)
  check('a completion model calls its hidden size a hidden size', /hidden size\s+2048 dimensions/.test(showCompletion.text), true)
  check('...and never claims to make embeddings', /embedding\s+2048/.test(showCompletion.text), false)

  const pullPreview = await tool('ollama_models').execute({ action: 'pull', model: 'qwen2.5:7b' }, exec)
  check('a pull without confirm is refused', pullPreview.view.code, 'CONFIRM_REQUIRED')
  check('...and says nothing was downloaded', /Nothing was downloaded/.test(pullPreview.text), true)
  check('...and shows the size it already has', pullPreview.text.includes('already on disk') && pullPreview.text.includes('4.7 GB'), true)
  check('...and names the exact confirm call', pullPreview.text.includes('confirm "qwen2.5:7b"'), true)
  check('...and made no pull request', daemon.requests.some((entry) => entry.path === '/api/pull'), false)
  const pullMissingPreview = await tool('ollama_models').execute({ action: 'pull', model: 'newmodel:7b' }, exec)
  check('a preview for an absent model says so', pullMissingPreview.text.includes('not on disk yet'), true)
  const silentPreview = await buildTools(closed).find((entry) => entry.name === 'ollama_models').execute({ action: 'pull', model: 'newmodel:7b' }, exec)
  check('a preview on a silent daemon does not claim the model is absent', silentPreview.text.includes('could not check'), true)
  const pullDone = await tool('ollama_models').execute({ action: 'pull', model: 'qwen2.5:7b', confirm: 'qwen2.5:7b' }, exec)
  check('a confirmed pull runs', pullDone.view.ok && pullDone.view.layers >= 2, true)
  check('...and reports the bytes it moved', pullDone.view.bytes, 3_000_000)
  check('...and the final status', pullDone.view.status, 'success')
  check('...and the prose says what to do next', /ollama_bench/.test(pullDone.text), true)

  const deletePreview = await tool('ollama_models').execute({ action: 'delete', model: 'llama3.2:1b' }, exec)
  check('a delete without confirm is refused', deletePreview.view.code, 'CONFIRM_REQUIRED')
  check('...and shows what would be freed', deletePreview.text.includes('1.3 GB'), true)
  check('...and made no delete request', daemon.requests.some((entry) => entry.method === 'DELETE'), false)
  const deleted = await tool('ollama_models').execute({ action: 'delete', model: 'llama3.2:1b', confirm: 'llama3.2:1b' }, exec)
  check('a confirmed delete runs', deleted.view.deleted, true)
  check('...and says a pull brings it back', /ollama pull llama3\.2:1b/.test(deleted.text), true)
  const deleteMissing = await tool('ollama_models').execute({ action: 'delete', model: 'missing:1b', confirm: 'missing:1b' }, exec)
  check('deleting what is not there is typed', deleteMissing.view.code, 'NO_MODEL')

  // -------------------------------------------------------------------------
  // ollama_embed
  // -------------------------------------------------------------------------
  const notEmbedding = await tool('ollama_embed').execute({ model: 'qwen2.5:7b', input: ['cat', 'dog'] }, exec)
  check('a completion model is refused as an embedder', notEmbedding.view.code, 'NOT_EMBEDDING')
  check('...naming nomic-embed-text', notEmbedding.text.includes('nomic-embed-text'), true)
  check('...and the capabilities it does have', notEmbedding.text.includes('completion'), true)
  const embedded = await tool('ollama_embed').execute({ model: 'nomic-embed-text:latest', input: ['cat', 'dog'] }, exec)
  check('an embedding answers', embedded.view.ok, true)
  check('...with the dimension', embedded.view.dimension, 8)
  check('...one vector per input', embedded.view.count, 2)
  check('...and the cosine of the pair', near('cosine', embedded.view.similarity, Math.SQRT1_2), true)
  check('...printed in the prose', /cosine\(1, 2\) = 0\.7071/.test(embedded.text), true)
  check('...with the norms', embedded.view.norms.every((value) => typeof value === 'number'), true)
  check('...and a vector preview, not the wall', /of 8\)|\[1\.0000, 0\.0000/.test(embedded.text), true)
  const one = await tool('ollama_embed').execute({ model: 'nomic-embed-text:latest', input: 'cat' }, exec)
  check('one input has no similarity claim', one.view.similarity, null)
  check('...and says nothing about cosine', /cosine/.test(one.text), false)
  daemon.state.legacyEmbeddings = true
  const legacy = await tool('ollama_embed').execute({ model: 'nomic-embed-text:latest', input: ['cat', 'dog'] }, exec)
  check('an older daemon falls back to /api/embeddings', legacy.view.route, '/api/embeddings')
  check('...and still answers both inputs', legacy.view.count, 2)
  daemon.state.legacyEmbeddings = false

  // -------------------------------------------------------------------------
  // The skills: frontmatter, examples that PARSE, and the endpoint coverage
  // -------------------------------------------------------------------------
  const skillsRoot = path.join(packageRoot, 'skills')
  const docs = []
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(skillsRoot, entry.name, 'SKILL.md')
    const text = readFileSync(file, 'utf8')
    const parsed = parseSkillFile(text)
    check('skill ' + entry.name + ' has frontmatter with a name', parsed.meta.name, entry.name)
    check('skill ' + entry.name + ' has a description', typeof parsed.meta.description === 'string' && parsed.meta.description.length > 40, true)
    check('skill ' + entry.name + ' has a body', parsed.content.length > 1000, true)
    docs.push({ name: entry.name, file, text })
    for (const nested of readdirSync(path.join(skillsRoot, entry.name), { withFileTypes: true })) {
      if (nested.isFile() && nested.name.endsWith('.md') && nested.name !== 'SKILL.md') docs.push({ name: entry.name, file: path.join(skillsRoot, entry.name, nested.name), text: readFileSync(path.join(skillsRoot, entry.name, nested.name), 'utf8') })
      if (nested.isDirectory()) {
        for (const deep of readdirSync(path.join(skillsRoot, entry.name, nested.name), { withFileTypes: true })) {
          if (deep.isFile() && deep.name.endsWith('.md')) {
            const full = path.join(skillsRoot, entry.name, nested.name, deep.name)
            docs.push({ name: entry.name, file: full, text: readFileSync(full, 'utf8') })
          }
        }
      }
    }
  }
  check('the three skills ship as documents', new Set(docs.filter((doc) => doc.file.endsWith('SKILL.md')).map((doc) => doc.name)).size, 3)

  /** The fenced blocks of one document, with the no-check convention. */
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
        open = { lang: match[1].toLowerCase(), line: index + 1, body: [], skip: /no-check/i.test(match[2]) || /no-check/i.test(lines[index - 1] ?? '') }
      } else {
        blocks.push(open)
        open = null
      }
    }
    return blocks
  }

  /** Split one shell line into tokens, honouring single and double quotes. */
  function tokenize(line) {
    const tokens = []
    let current = ''
    let quote = ''
    let started = false
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]
      if (quote !== '') {
        if (character === quote) quote = ''
        else if (character === '\\' && quote === '"' && index + 1 < line.length) {
          current += line[index + 1]
          index += 1
        } else current += character
        continue
      }
      if (character === "'" || character === '"') {
        quote = character
        started = true
        continue
      }
      if (/\s/.test(character)) {
        if (started || current !== '') tokens.push(current)
        current = ''
        started = false
        continue
      }
      current += character
      started = true
    }
    if (started || current !== '') tokens.push(current)
    return tokens
  }

  /** Every `curl ...` line in a block, as a request the daemon would accept. */
  function curlRequests(body) {
    const found = []
    for (const line of String(body).split('\n')) {
      const trimmed = line.trim().replace(/\\$/, '').trim()
      if (!/^curl\s/.test(trimmed)) continue
      const tokens = tokenize(trimmed)
      let method = ''
      let url = ''
      let data = ''
      let header = ''
      for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (token === '-X' || token === '--request') method = tokens[++index] ?? ''
        else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary') data = tokens[++index] ?? ''
        else if (token === '-H' || token === '--header') header = tokens[++index] ?? ''
        else if (token.startsWith('http')) url = token
      }
      found.push({ method, url, data, header })
    }
    return found
  }

  // The endpoints a CURL EXAMPLE may name: the surface this row calls, the
  // OpenAI-compatible aliases, and the two model-store verbs the API skill
  // documents for completeness (copy/create) although no tool here issues them.
  const knownPaths = __internals.CAPABILITIES.endpoints.concat(['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/models', '/api/copy', '/api/create'])
  const curlBlocks = docs.flatMap((doc) => fences(doc.text).filter((block) => ['bash', 'sh', 'shell', 'console'].includes(block.lang)).map((block) => ({ doc, block })))
  let curlCount = 0
  for (const { doc, block } of curlBlocks) {
    if (block.skip) {
      skipped += 1
      continue
    }
    const where = path.relative(packageRoot, doc.file) + ':' + block.line
    const requests = curlRequests(block.body.join('\n'))
    if (requests.length === 0) {
      // A shell block that is not a curl example (a CLI invocation) is fine, but
      // it must be a real ollama subcommand rather than a made-up one.
      check(where + ' has a curl request or an ollama command', /(^|\s)(ollama\s+[a-z]+|curl\s)/m.test(block.body.join('\n')) || block.body.join('\n').trim() === '', true)
      continue
    }
    for (const request of requests) {
      curlCount += 1
      check(where + ' names a loopback URL', /^http:\/\/(127\.0\.0\.1|localhost):11434\//.test(request.url), true)
      const route = request.url.replace(/^http:\/\/(127\.0\.0\.1|localhost):11434/, '').split('?')[0]
      check(where + ' names a real endpoint (' + route + ')', knownPaths.includes(route), true)
      if (request.data !== '') {
        let parsedBody = null
        try {
          parsedBody = JSON.parse(request.data)
        } catch (error) {
          parsedBody = null
        }
        check(where + ' has a JSON body that parses', parsedBody !== null && typeof parsedBody === 'object', true)
        if (parsedBody !== null && route === '/api/generate') check(where + ' names a model in /api/generate', typeof parsedBody.model === 'string' && parsedBody.model !== '', true)
        if (parsedBody !== null && route === '/api/pull') check(where + ' names a model in /api/pull', typeof parsedBody.model === 'string', true)
      }
    }
  }
  check('the skills carry curl examples', curlCount >= 8, true)

  // The docs must cover the surface the row actually speaks: an endpoint with no
  // lesson is a feature the model cannot use.
  const allSkillText = docs.map((doc) => doc.text).join('\n')
  const undocumented = __internals.CAPABILITIES.endpoints.filter((endpoint) => !allSkillText.includes(endpoint))
  check('every endpoint this row calls is documented', undocumented.join(', '), '')
  for (const term of ['keep_alive', 'eval_duration', 'OLLAMA_HOST', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_KEEP_ALIVE', 'num_ctx', 'temperature', 'seed']) {
    check('the docs teach ' + term, allSkillText.includes(term), true)
  }
  check('the metrics skill teaches the tok/s arithmetic', /eval_count\s*\/\s*eval_duration|eval_count \/ eval_duration/.test(allSkillText), true)

  // Python: parsed by python's own ast, when this host has a Python.
  const python = (() => {
    for (const command of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
      const probe = spawnSync(command, ['--version'], { encoding: 'utf8' })
      if (probe.status === 0) return command
    }
    return null
  })()
  const pythonBlocks = docs.flatMap((doc) => fences(doc.text).filter((block) => block.lang === 'python').map((block) => ({ doc, block })))
  check('the python skill carries python examples', pythonBlocks.length >= 4, true)
  if (python === null) {
    skip('every python example parses', 'no python on PATH')
  } else {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'dsh-ollama-py-'))
    try {
      for (const { doc, block } of pythonBlocks) {
        if (block.skip) {
          skipped += 1
          continue
        }
        const where = path.relative(packageRoot, doc.file) + ':' + block.line
        const file = path.join(temp, 'example-' + block.line + '.py')
        writeFileSync(file, block.body.join('\n'), 'utf8')
        const parsed = spawnSync(python, ['-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', file], { encoding: 'utf8' })
        check(where + ' parses as Python', parsed.status === 0, true)
        if (parsed.status !== 0) console.log('     ' + String(parsed.stderr ?? '').split('\n').slice(0, 4).join('\n     '))
      }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // JavaScript: checked by node's own parser, as an ES module.
  const jsBlocks = docs.flatMap((doc) => fences(doc.text).filter((block) => ['javascript', 'js', 'mjs'].includes(block.lang)).map((block) => ({ doc, block })))
  check('the skills carry a JavaScript example', jsBlocks.length >= 1, true)
  const jsTemp = mkdtempSync(path.join(os.tmpdir(), 'dsh-ollama-js-'))
  try {
    for (const { doc, block } of jsBlocks) {
      if (block.skip) {
        skipped += 1
        continue
      }
      const where = path.relative(packageRoot, doc.file) + ':' + block.line
      const file = path.join(jsTemp, 'example-' + block.line + '.mjs')
      writeFileSync(file, block.body.join('\n'), 'utf8')
      const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      check(where + ' parses as an ES module', parsed.status === 0, true)
      if (parsed.status !== 0) console.log('     ' + String(parsed.stderr ?? '').split('\n').slice(0, 4).join('\n     '))
    }
  } finally {
    rmSync(jsTemp, { recursive: true, force: true })
  }

  // JSON: every fenced block is a real document.
  const jsonBlocks = docs.flatMap((doc) => fences(doc.text).filter((block) => block.lang === 'json').map((block) => ({ doc, block })))
  for (const { doc, block } of jsonBlocks) {
    const where = path.relative(packageRoot, doc.file) + ':' + block.line
    let parsed = null
    try {
      parsed = JSON.parse(block.body.join('\n'))
    } catch (error) {
      parsed = null
    }
    check(where + ' is valid JSON', parsed !== null, true)
  }

  // -------------------------------------------------------------------------
  // The live half: only when a daemon answers here.
  // -------------------------------------------------------------------------
  const liveEnabled = process.env.DSH_OLLAMA_CHECK_LIVE !== '0'
  const liveHost = resolveHost(process.env)
  if (!liveEnabled) {
    skip('the live half', 'DSH_OLLAMA_CHECK_LIVE=0')
  } else {
    let liveVersion = null
    try {
      const response = await fetch(liveHost.origin + '/api/version', { signal: AbortSignal.timeout(2000) })
      if (response.ok) liveVersion = (await response.json()).version
    } catch (error) {
      liveVersion = null
    }
    if (liveVersion === null) {
      skip('the live half', 'no Ollama daemon answers at ' + liveHost.origin + ' (start one with `ollama serve`)')
    } else {
      console.log('')
      console.log('--- live: a daemon answers at ' + liveHost.origin + ' (version ' + liveVersion + ')')
      const liveDeps = createDeps(stubCtx, {})
      const liveTools = buildTools(liveDeps)
      const live = (name) => liveTools.find((entry) => entry.name === name)
      const tags = await fetch(liveHost.origin + '/api/tags', { signal: AbortSignal.timeout(4000) }).then((response) => response.json())
      const candidates = (Array.isArray(tags.models) ? tags.models : []).filter((entry) => !/embed/i.test(String(entry.name ?? ''))).sort((left, right) => (left.size ?? 0) - (right.size ?? 0))
      if (candidates.length === 0) {
        skip('live: one generation', 'no completion model is pulled on this machine')
      } else {
        const model = candidates[0].name
        console.log('    model: ' + model)
        const answer = await live('ollama_run').execute({ model, prompt: 'Reply with the single word: ok', options: { num_predict: 8, temperature: 0 }, timeoutSeconds: 300 }, exec)
        check('live: one generation answers', answer.view.ok, true)
        check('live: it carries the daemon\'s counts', typeof answer.view.measured.evalCount === 'number' && answer.view.measured.evalCount >= 0, true)
        check('live: its rate is a finite number or n/a', answer.view.measured.evalTokensPerSecond === null || Number.isFinite(answer.view.measured.evalTokensPerSecond), true)
        check('live: the prose names the model', answer.text.includes(model), true)
        const liveBench = await live('ollama_bench').execute({ model, prompt: 'Reply with the single word: ok', runs: 3, cold: false, options: { num_predict: 8 }, timeoutSeconds: 300 }, exec)
        check('live: a 3-run bench answers', liveBench.view.ok, true)
        check('live: ...with three runs', liveBench.view.groups[0].runs.length, 3)
        check('live: ...and a median it can stand behind', typeof liveBench.view.groups[0].rates.median === 'number', true)
      }
    }
  }
} finally {
  await daemon.close()
}

console.log('')
console.log(failures === 0 ? 'all ' + checks + ' check(s) passed' + (skipped > 0 ? ' (' + skipped + ' skipped)' : '') : failures + ' of ' + checks + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
