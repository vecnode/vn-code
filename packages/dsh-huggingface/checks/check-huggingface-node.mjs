// check-huggingface-node.mjs - dsh-huggingface's own contract, driven end to end.
//
// Nothing here needs the network and nothing here can delete a real cache:
//
//   - the CACHE is a fixture tree in a temp directory, built to the layout the
//     library actually uses (blobs + snapshots + refs), including the two cases
//     that make a naive size rule wrong - a blobs cache whose bytes must NOT be
//     added to the snapshot copies, and a cache with NO blobs at all (the Xet /
//     Windows-copy case measured on the machine that wrote this);
//   - the CLI is a FAKE runner: it records the exact argv and answers canned
//     JSON, which is the only way to assert the `-y` / `--dry-run` decision
//     without touching somebody's 17 GB download;
//   - the CONFIRMATION rules are asserted where they matter: a download over its
//     ceiling runs NO download, and an unconfirmed removal is a dry run.
//
// Run:  node checks/check-huggingface-node.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HfError, classifyFailure } from '../lib/errors.js'
import { offlineOf, resolveCacheRoot, tokenPresence } from '../lib/paths.js'
import { describeRepoDir, repoDirName, scanCache, splitRepoDir } from '../lib/cache.js'
import { CAPS, validateCache, validateDownload, validateRepo, validateSearch } from '../lib/validate.js'
import {
  buildCacheArgv,
  buildDownloadArgv,
  buildInfoArgv,
  buildSearchArgv,
  consumersOf,
  globToRegExp,
  normalizeInfo,
  parseDownloadAnswer,
  projectDownload,
  selected,
} from '../lib/hf.js'
import { CLI_CANDIDATES, parseVersion, resolveCli } from '../lib/cli.js'
import { buildTools, formatBytes, formatParamCount } from '../lib/tools.js'
import { SKILL_FILES, apply, createDeps, parseSkillFile, PLUGIN_VERSION, __internals } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(here, '..')
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

let checks = 0
let failures = 0
let skipped = 0
const check = (label, actual, expected) => {
  checks += 1
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(62) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}
const skip = (label, reason) => {
  skipped += 1
  console.log('skip ' + label.padEnd(62) + ' (' + reason + ')')
}

// ---------------------------------------------------------------------------
// The fixture cache
// ---------------------------------------------------------------------------
/** Write a file, creating its directory. */
function put(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/**
 * Build a cache that has all three layouts this row must survive:
 *   - acme/alpha: blobs AND a snapshot copy of the same bytes (must not double)
 *   - acme/stub:  one config.json, no weight file (the 40-of-50 case)
 *   - acme/data:  a DATASET whose bytes are a parquet, not a weight
 *   - acme/beta:  a complete model at an OLD revision (staleness)
 */
function makeCache() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-hf-cache-'))
  // acme/alpha - canonical blobs layout, plus a snapshot copy that must not be added
  const alpha = path.join(root, 'models--acme--alpha')
  put(path.join(alpha, 'refs', 'main'), SHA_A + '\n')
  put(path.join(alpha, 'blobs', 'f'.repeat(64)), Buffer.alloc(3000, 1))
  put(path.join(alpha, 'blobs', 'e'.repeat(64)), Buffer.alloc(100, 2))
  put(path.join(alpha, 'snapshots', SHA_A, 'model.safetensors'), Buffer.alloc(3000, 1))
  put(path.join(alpha, 'snapshots', SHA_A, 'config.json'), Buffer.alloc(100, 2))
  // acme/stub - metadata only
  const stub = path.join(root, 'models--acme--stub')
  put(path.join(stub, 'refs', 'main'), SHA_B + '\n')
  put(path.join(stub, 'snapshots', SHA_B, 'config.json'), '{"model_type":"qwen3"}')
  // acme/data - dataset, no weights by definition
  const data = path.join(root, 'datasets--acme--data')
  put(path.join(data, 'snapshots', 'c'.repeat(40), 'train.parquet'), Buffer.alloc(2_000_000, 3))
  // acme/beta - complete model, old revision
  const beta = path.join(root, 'models--acme--beta')
  put(path.join(beta, 'refs', 'main'), 'd'.repeat(40) + '\n')
  put(path.join(beta, 'snapshots', 'd'.repeat(40), 'model.safetensors'), Buffer.alloc(5000, 4))
  return root
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------
check('the package is a dsh bundle with a patch layer', manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch, './cordis.patch.yml')
check('the row owns no browser half', manifest.dsh.client === undefined, true)
check('the row has no npm dependency', manifest.dependencies === undefined && manifest.peerDependencies === undefined, true)
check('the version is the alpha this check knows', manifest.version, PLUGIN_VERSION)
check('the skills and checks ship in the package', ['lib', 'skills', 'checks', 'cordis.patch.yml'].every((entry) => manifest.files.includes(entry)), true)

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------
const home = path.join(os.tmpdir(), 'fake-home')
check('no variable means the default cache', resolveCacheRoot({}, home).root, path.join(home, '.cache', 'huggingface', 'hub'))
check('...and says so', resolveCacheRoot({}, home).from, 'default')
check('HF_HOME puts the cache under it', resolveCacheRoot({ HF_HOME: '/big/hf' }, home).root, path.join(path.resolve('/big/hf'), 'hub'))
check('HF_HUB_CACHE wins over HF_HOME', resolveCacheRoot({ HF_HUB_CACHE: '/c1', HF_HOME: '/big/hf' }, home).root, path.resolve('/c1'))
check('HUGGINGFACE_HUB_CACHE is the older name', resolveCacheRoot({ HUGGINGFACE_HUB_CACHE: '/c2', HF_HOME: '/big' }, home).from, 'HUGGINGFACE_HUB_CACHE')
check('an empty variable is not a path', resolveCacheRoot({ HF_HUB_CACHE: '  ' }, home).from, 'default')
check('TRANSFORMERS_CACHE is read last and marked deprecated', resolveCacheRoot({ TRANSFORMERS_CACHE: '/old' }, home).deprecated, true)
check('offline is read from HF_HUB_OFFLINE', offlineOf({ HF_HUB_OFFLINE: '1' }), true)
check('...and from TRANSFORMERS_OFFLINE', offlineOf({ TRANSFORMERS_OFFLINE: 'true' }), true)
check('...and "0" is not offline', offlineOf({ HF_HUB_OFFLINE: '0' }), false)
check('a token is reported by PRESENCE only', tokenPresence({ HF_TOKEN: 'hf_secretvalue' }, false).source, 'HF_TOKEN')
check('...and never carries the value', JSON.stringify(tokenPresence({ HF_TOKEN: 'hf_secretvalue' }, false)).includes('secretvalue'), false)
check('a stored token file counts as present', tokenPresence({}, true).present, true)
check('no token at all', tokenPresence({}, false).present, false)

// ---------------------------------------------------------------------------
// The cache scan
// ---------------------------------------------------------------------------
const root = makeCache()
const scan = scanCache(root)
check('the scan finds every repo', scan.counts.repos, 4)
check('...and marks the directory as present', scan.exists, true)
check('the count splits complete from metadata-only', scan.counts.stubs, 1)
check('...with the rest complete', scan.counts.complete, 3)
check('types are counted separately', scan.counts.byType.dataset, 1)
check('splitRepoDir reads a model directory', splitRepoDir('models--acme--alpha').id, 'acme/alpha')
check('splitRepoDir reads a dataset directory', splitRepoDir('datasets--acme--data').type, 'dataset')
check('a directory that is not a repo is refused', splitRepoDir('random-folder'), null)
check('repoDirName is the inverse', repoDirName('model', 'acme/alpha'), 'models--acme--alpha')

const alpha = describeRepoDir(root, 'models--acme--alpha')
check('a blobs cache is measured on the blobs side', alpha.layout, 'blobs')
check('...and the snapshot copies are NOT added to it', alpha.bytes, 3100)
check('...so the double-counted number is not what is reported', alpha.bytes !== 6200, true)
check('a hash-named blob still counts as a weight (via the snapshot name)', alpha.weights, true)
check('a complete repo is not a stub', alpha.stub, false)
check('the revision comes from refs/main', alpha.revision, SHA_A)

const noBlobs = describeRepoDir(root, 'models--acme--beta')
check('a cache with no blobs is measured on the snapshots side', noBlobs.layout, 'snapshots')
check('...and its bytes are the copies\'', noBlobs.bytes, 5000)

const stub = describeRepoDir(root, 'models--acme--stub')
check('a metadata-only model is a stub', stub.stub, true)
check('...and says it has no weight file', stub.weights, false)

const dataset = describeRepoDir(root, 'datasets--acme--data')
check('a dataset is not called weightless at 2 MB', dataset.stub, false)
check('...although it has no weight file', dataset.weights, false)
check('a dataset is still a stub when it is only metadata', describeRepoDir(root, 'datasets--acme--data').stub === false, true)

const filtered = scanCache(root, { type: 'model' })
check('a type filter drops the others', filtered.counts.repos, 3)
const byName = scanCache(root, { filter: 'alph' })
check('a text filter selects by id', byName.repos.length === 1 && byName.repos[0].id, 'acme/alpha')
const limited = scanCache(root, { limit: 2 })
check('a limit shortens the list', limited.repos.length, 2)
check('...and is reported as limited', limited.limited, true)
check('a missing cache root is an answer, not an error', scanCache(path.join(root, 'nope')).exists, false)

// ---------------------------------------------------------------------------
// The CLI: the version trap, and how the binary is found
// ---------------------------------------------------------------------------
const stderrHint = 'Hint: A new version of huggingface_hub (2.5.0) is available! You are using version 1.26.1.\nTo update, run: hf update'
check('the version is read from STDOUT, not the upgrade hint', parseVersion('1.26.1\n', stderrHint), '1.26.1')
check('...so the "available" version is never reported as installed', parseVersion('1.26.1\n', stderrHint) !== '2.5.0', true)
check('a stream with no stdout falls back to stderr', parseVersion('', 'huggingface_hub version: 0.20.3'), '0.20.3')
check('the upgrade hint alone yields NO version', parseVersion('', stderrHint), '')
check('the candidates are the modern name first', CLI_CANDIDATES[0], 'hf')
check('classifyFailure: gated before a bare 403', classifyFailure('403 Forbidden: access to model is restricted', 403), 'GATED')
check('classifyFailure: dataset 404', classifyFailure('404 Client Error: Repository Not Found', 404), 'NOT_FOUND')
check('classifyFailure: auth', classifyFailure('Invalid credentials in Authorization header', 401), 'AUTH')
check('classifyFailure: rate limit', classifyFailure('429 Too Many Requests', 429), 'RATE_LIMIT')
check('classifyFailure: no space', classifyFailure('OSError: [Errno 28] No space left on device', 1), 'DISK_FULL')
check('classifyFailure: network', classifyFailure('getaddrinfo failed for huggingface.co', 1), 'NETWORK')
check('classifyFailure: anything else', classifyFailure('some new message', 1), 'OUTPUT')

const missing = await resolveCli({ env: {}, cache: {}, runner: async () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }) })
check('no CLI is a result, not an exception', missing.bin, null)
check('...and every candidate was tried', missing.tried.length, 2)
const pinnedMiss = await resolveCli({ env: { DSH_HF_CLI: '/opt/hf' }, cache: {}, runner: async (argv) => ({ status: argv[0] === '/opt/hf' ? 0 : null, stdout: '9.9.9', stderr: '' }) })
check('DSH_HF_CLI pins a binary PATH does not carry', pinnedMiss.bin + ' ' + pinnedMiss.version, '/opt/hf 9.9.9')
check('...and is named as the source', pinnedMiss.source, 'DSH_HF_CLI')

// ---------------------------------------------------------------------------
// argv: the flags that keep a removal from hanging or acting unasked
// ---------------------------------------------------------------------------
const bin = 'hf'
check('search argv asks for JSON last', buildSearchArgv(bin, { group: 'models', query: 'qwen3', limit: 5, author: '', filters: [], sort: 'downloads' }).slice(-2).join(' '), '--format json')
check('search argv carries the query', buildSearchArgv(bin, { group: 'models', query: 'qwen3', limit: 5, author: '', filters: [], sort: '' }).includes('qwen3'), true)
check('info argv expands the fields this row reads', buildInfoArgv(bin, { group: 'models', repo: 'acme/alpha' }).join(',').includes('siblings'), true)
check('an UNCONFIRMED rm is the CLI\'s own dry run', buildCacheArgv(bin, { action: 'rm', type: 'model', repo: 'acme/alpha', confirm: '', revision: '' }).includes('--dry-run'), true)
check('...and does NOT pass -y', buildCacheArgv(bin, { action: 'rm', type: 'model', repo: 'acme/alpha', confirm: '', revision: '' }).includes('--yes'), false)
check('a confirmed rm passes -y (stdin is closed, so a prompt would hang)', buildCacheArgv(bin, { action: 'rm', type: 'model', repo: 'acme/alpha', confirm: 'acme/alpha', revision: '' }).includes('--yes'), true)
check('a rm target is <type>/<repo>', buildCacheArgv(bin, { action: 'rm', type: 'model', repo: 'acme/alpha', confirm: 'acme/alpha', revision: '' })[3], 'model/acme/alpha')
check('prune is confirmed by the word "prune"', buildCacheArgv(bin, { action: 'prune', confirm: 'prune' }).includes('--yes'), true)
check('...and is a dry run otherwise', buildCacheArgv(bin, { action: 'prune', confirm: '' }).includes('--dry-run'), true)
check('verify passes the repo type', buildCacheArgv(bin, { action: 'verify', type: 'dataset', repo: 'acme/data', revision: '', confirm: '' }).join(' '), 'hf cache verify acme/data --type dataset --format json')
check('download argv never carries a token', buildDownloadArgv(bin, { repo: 'acme/alpha', type: 'model', files: ['config.json'], include: ['*.safetensors'], exclude: [], revision: '', maxBytes: 1, confirm: 'acme/alpha' }).some((entry) => entry === '--token'), false)

// ---------------------------------------------------------------------------
// Patterns and projection
// ---------------------------------------------------------------------------
check('* stays inside one segment', globToRegExp('*.safetensors').test('sub/x.safetensors'), false)
check('...and matches the bare name', globToRegExp('*.safetensors').test('x.safetensors'), true)
check('** crosses segments', globToRegExp('**/*.safetensors').test('sub/x.safetensors'), true)
check('an exclude always wins', selected('model.safetensors', ['*.safetensors'], ['model.*']), false)
check('an empty include means everything', selected('whatever.bin', [], []), true)

const infoFixture = {
  id: 'acme/alpha',
  sha: SHA_A,
  gated: 'manual',
  private: false,
  downloads: 12345,
  likes: 678,
  pipeline_tag: 'text-generation',
  library_name: 'transformers',
  lastModified: '2026-11-01T10:00:00.000Z',
  cardData: { license: 'apache-2.0' },
  tags: ['license:apache-2.0', 'text-generation'],
  safetensors: { total: 8_800_000_000 },
  config: { architectures: ['Qwen3ForCausalLM'], model_type: 'qwen3', max_position_embeddings: 32768 },
  siblings: [
    { rfilename: 'config.json', size: 800 },
    { rfilename: 'tokenizer.json', size: 11_000 },
    { rfilename: 'model.safetensors', size: 17_000_000 },
    { rfilename: 'README.md' },
  ],
}
const info = normalizeInfo(infoFixture, { repo: 'acme/alpha', type: 'model', group: 'models' })
check('normalizeInfo reads the licence', info.licence, 'apache-2.0')
check('...the gated status', info.gated, 'manual')
check('...the parameter count', info.params, 8_800_000_000)
check('...the architecture', info.architectures[0], 'Qwen3ForCausalLM')
check('...the context length', info.contextLength, 32768)
check('...and the sum of the sizes it was given', info.totalBytes, 17_011_800)
check('a file with no size makes the total a LOWER BOUND', info.sizesComplete, false)
check('...and is counted as unknown', info.unknownSizes, 1)
check('a licence tag is used when the card has none', normalizeInfo({ tags: ['license:mit'] }, { repo: 'a/b', type: 'model' }).licence, 'mit')

// The MEASURED shape of this CLI line: no per-file sizes, only used_storage.
const hubSized = normalizeInfo(
  { ...infoFixture, siblings: infoFixture.siblings.map((entry) => ({ rfilename: entry.rfilename })), used_storage: 4_105_073_268 },
  { repo: 'acme/alpha', type: 'model' },
)
check('used_storage is the repo total when no file size is given', hubSized.totalBytes, 4_105_073_268)
check('...and the measure is named', hubSized.totalSource, 'hub storage')
check('...with per-file sizes reported as absent', hubSized.sizesComplete, false)
const hubPlan = projectDownload(hubSized, { files: [], include: [], exclude: [], maxBytes: 1 })
check('a whole-repo selection is measured by used_storage', hubPlan.bytes, 4_105_073_268)
check('...labelled as the repo measure', hubPlan.measured, 'repo')
check('...and counts as measured', hubPlan.complete, true)
const partialPlan = projectDownload(hubSized, { files: [], include: ['*.safetensors'], exclude: [], maxBytes: 1 })
check('a partial selection with no file sizes is NOT measured', partialPlan.bytes, null)
check('...and says so rather than inventing a number', partialPlan.measured, 'unknown')

const plan = projectDownload(info, { files: [], include: ['*.safetensors'], exclude: [], maxBytes: 1 })
check('the projection filters to the include patterns', plan.files.join(','), 'model.safetensors')
check('...and sums exactly those bytes', plan.bytes, 17_000_000)
check('...reporting a known total as complete', plan.complete, true)
const everything = projectDownload(info, { files: [], include: [], exclude: [], maxBytes: 1 })
check('no pattern means the whole repo', everything.files.length, 4)
check('...which is a lower bound here', everything.complete, false)

const consumers = consumersOf(info.files)
check('a transformers consumer is detected', consumers.some((entry) => entry.consumer === 'transformers'), true)
check('...and it names the config first', consumers[0].files.includes('config.json'), true)
check('gguf quants are their own consumer', consumersOf([{ name: 'a-Q4_K_M.gguf' }, { name: 'a-Q8_0.gguf' }]).some((entry) => entry.consumer === 'llama.cpp / Ollama'), true)
check('a repo with no consumer match says nothing', consumersOf([{ name: 'train.parquet' }]).length, 0)

check('a download answer as an array', parseDownloadAnswer(['a.json']).shape, 'array')
check('...as an object', parseDownloadAnswer({ downloaded: ['b.json'] }).paths[0], 'b.json')
check('...as loose lines', parseDownloadAnswer({ lines: ['c.json'] }).paths[0], 'c.json')

// ---------------------------------------------------------------------------
// Validation: refusals, never clamps
// ---------------------------------------------------------------------------
const rejects = (label, fn, code) => {
  try {
    fn()
    check(label, 'no error', code)
  } catch (error) {
    check(label, error instanceof HfError ? error.code : 'wrong type: ' + error, code)
  }
}
rejects('a local path is not a repo id', () => validateRepo({ repo: './local/model' }), 'BAD_INPUT')
rejects('a single name is not a repo id', () => validateRepo({ repo: 'gpt2' }), 'BAD_INPUT')
rejects('an unknown type is refused', () => validateRepo({ repo: 'a/b', type: 'widget' }), 'BAD_INPUT')
rejects('a limit of 500 is refused, not clamped', () => validateSearch({ limit: 500 }), 'BAD_INPUT')
rejects('an unknown sort is refused', () => validateSearch({ sort: 'popularity' }), 'BAD_INPUT')
rejects('a files entry with .. is refused', () => validateDownload({ repo: 'a/b', files: ['../../etc/passwd'] }), 'BAD_INPUT')
rejects('an absolute files entry is refused', () => validateDownload({ repo: 'a/b', files: ['/etc/passwd'] }), 'BAD_INPUT')
rejects('a maxBytes under 1 MiB is refused', () => validateDownload({ repo: 'a/b', maxBytes: 5 }), 'BAD_INPUT')
rejects('an unknown cache action is refused', () => validateCache({ action: 'burn' }), 'BAD_INPUT')
check('a valid repo normalises', validateRepo({ repo: ' acme/alpha ' }).repo, 'acme/alpha')
check('the default ceiling is 8 GiB', CAPS.maxDownloadBytes, 8 * 1024 ** 3)

// ---------------------------------------------------------------------------
// The tools, end to end, against a fake CLI
// ---------------------------------------------------------------------------
/**
 * A deps object whose runner records every argv.
 *
 * @param env - the environment the row sees.
 * @param handlers - `(argv) => response | undefined`.
 */
function harness(env, handlers) {
  const calls = []
  const runner = async (argv) => {
    calls.push(argv.slice())
    const answer = handlers(argv)
    if (answer === undefined) return { status: 0, stdout: '{}', stderr: '', timedOut: false }
    return { status: 0, stdout: '', stderr: '', timedOut: false, ...answer }
  }
  const deps = createDeps({ logger: { info() {}, warn() {} } }, { env, runner, now: () => 0 })
  return { deps, calls, tools: buildTools(deps) }
}
const tool = (tools, name) => tools.find((entry) => entry.name === name)
const versionOk = { status: 0, stdout: '1.26.1\n', stderr: 'Hint: a new version (2.5.0) is available.' }

// status: one process, no network
{
  const { calls, tools } = harness({ HF_HUB_CACHE: root }, () => versionOk)
  const answer = await tool(tools, 'hf_status').execute({})
  check('hf_status reports the CLI', answer.view.cli.bin + ' ' + answer.view.cli.version, 'hf 1.26.1')
  check('hf_status counts the fixture repos', answer.view.cache.counts.repos, 4)
  check('hf_status separates the stub', answer.view.cache.counts.stubs, 1)
  check('hf_status names the stub', answer.view.stubs[0].id, 'acme/stub')
  check('hf_status made exactly ONE process call', calls.length, 1)
  check('...and it was the version probe', calls[0].join(' '), 'hf --version')
  check('hf_status is read-only over the cache', existsSync(path.join(root, 'models--acme--stub')), true)
  check('...and reports auth as a presence, never a value', answer.view.auth.present, false)
  check('...naming the login command when there is none', answer.text.includes('hf auth login'), true)
}

// status with no CLI at all
{
  const { tools } = harness({ HF_HUB_CACHE: root }, () => ({ status: null, error: 'ENOENT' }))
  const answer = await tool(tools, 'hf_status').execute({})
  check('with no CLI the cache scan still answers', answer.view.cache.counts.repos, 4)
  check('...and the install line is named', answer.text.includes('pip install -U huggingface_hub'), true)
}

// search
{
  const results = [
    { id: 'acme/alpha', downloads: 1234, likes: 56, lastModified: '2026-10-02T00:00:00Z', library_name: 'transformers', pipeline_tag: 'text-generation' },
    { id: 'acme/beta', downloads: 99, likes: 1, lastModified: '2026-09-01T00:00:00Z' },
  ]
  const { calls, tools } = harness({}, () => ({ ...versionOk, status: 0, stdout: JSON.stringify(results) }))
  const answer = await tool(tools, 'hf_search').execute({ query: 'alpha', limit: 2, sort: 'downloads' })
  check('hf_search returns the ids', answer.view.count, 2)
  check('hf_search ranks a table by the columns asked for', answer.text.includes('acme/alpha'), true)
  check('hf_search passes --search and --limit', calls[1].join(' ').includes('--search alpha') && calls[1].includes('--limit'), true)

  const offline = harness({ HF_HUB_OFFLINE: '1' }, () => versionOk)
  const refused = await tool(offline.tools, 'hf_search').execute({ query: 'x' })
  check('offline search is refused with a code', refused.view.code, 'OFFLINE')
  check('...and makes NO process call', offline.calls.length, 0)
}

// repo: complete / absent / gated / offline
{
  const infoJson = JSON.stringify({ ...infoFixture, gated: false, sha: SHA_A })
  const { tools } = harness({ HF_HUB_CACHE: root }, (argv) => (argv[1] === 'models' && argv[2] === 'info' ? { ...versionOk, stdout: infoJson } : versionOk))
  const cached = await tool(tools, 'hf_repo').execute({ repo: 'acme/alpha' })
  check('hf_repo sees the local copy', cached.view.local.state, 'complete')
  check('...with its bytes', cached.view.local.entry.bytes, 3100)
  check('...and the Hub total', cached.view.repo.bytes, 17_011_800)
  check('...and the consumer grouping', cached.view.consumers[0].consumer, 'transformers')
  check('...and the lower-bound caveat in prose', cached.text.includes('LOWER BOUND'), true)

  const absent = await tool(tools, 'hf_repo').execute({ repo: 'acme/not-here' })
  check('hf_repo calls an uncached repo absent', absent.view.local.state, 'absent')
  check('...and the prose says not cached', absent.text.includes('not cached'), true)
  check('...and says nothing was downloaded', absent.text.includes('Nothing was downloaded') || absent.text.includes('hf_download'), true)

  const stale = await tool(tools, 'hf_repo').execute({ repo: 'acme/beta' })
  check('hf_repo detects a revision that moved', stale.view.local.state, 'stale')
  check('...and names the Hub revision it differs from', stale.text.includes(SHA_A.slice(0, 12)), true)

  const gatedInfo = JSON.stringify({ ...infoFixture, gated: 'manual' })
  const gated = harness({ HF_HUB_CACHE: root }, (argv) => (argv[2] === 'info' ? { ...versionOk, stdout: gatedInfo } : versionOk))
  const gatedAnswer = await tool(gated.tools, 'hf_repo').execute({ repo: 'acme/alpha' })
  check('hf_repo names a gated repo before a download', gatedAnswer.text.includes('GATED'), true)

  const offline = harness({ HF_HUB_CACHE: root, HF_HUB_OFFLINE: '1' }, () => versionOk)
  const offlineAnswer = await tool(offline.tools, 'hf_repo').execute({ repo: 'acme/alpha' })
  check('offline hf_repo reports the disk and says the Hub was not asked', offlineAnswer.view.offline, true)
  check('...and makes no call at all', offline.calls.length, 0)
}

// cache: list, verify, the two removals
{
  const { calls, tools } = harness({ HF_HUB_CACHE: root }, (argv) => (argv[1] === '--version' ? versionOk : { status: 0, stdout: '{}', stderr: '' }))
  const list = await tool(tools, 'hf_cache').execute({})
  check('hf_cache list needs no CLI', calls.length, 0)
  check('hf_cache list shows the stub as NO weights', list.text.includes('NO'), true)
  check('...and names the metadata-only count', list.view.counts.stubs, 1)

  const dry = await tool(tools, 'hf_cache').execute({ action: 'rm', repo: 'acme/alpha' })
  check('an unconfirmed rm is a DRY RUN', dry.text.startsWith('DRY RUN'), true)
  check('...and says nothing was removed', dry.text.includes('nothing was removed'), true)
  check('...and the repo still exists', existsSync(path.join(root, 'models--acme--alpha')), true)
  const rmCall = calls[calls.length - 1]
  check('...and the CLI was asked for a dry run', rmCall.includes('--dry-run') && !rmCall.includes('--yes'), true)
  check('...and reports the bytes a delete would cost', dry.view.before.bytes, 3100)

  await tool(tools, 'hf_cache').execute({ action: 'rm', repo: 'acme/alpha', confirm: 'acme/alpha' })
  check('a CONFIRMED rm passes -y', calls[calls.length - 1].includes('--yes'), true)

  await tool(tools, 'hf_cache').execute({ action: 'prune' })
  check('prune unconfirmed is a dry run', calls[calls.length - 1].includes('--dry-run'), true)
  await tool(tools, 'hf_cache').execute({ action: 'prune', confirm: 'prune' })
  check('prune confirmed passes -y', calls[calls.length - 1].includes('--yes'), true)

  await tool(tools, 'hf_cache').execute({ action: 'verify', repo: 'acme/alpha' })
  check('verify is the CLI\'s checksum pass', calls[calls.length - 1].slice(0, 3).join(' '), 'hf cache verify')
}

// download: ceiling, confirmation, then the real thing
{
  const dryInfo = JSON.stringify({
    ...infoFixture,
    gated: false,
    sha: 'f'.repeat(40),
    siblings: [
      { rfilename: 'config.json', size: 100 },
      { rfilename: 'model.safetensors', size: 10_000_000 },
      { rfilename: 'README.md', size: 2000 },
    ],
  })
  const downloads = []
  const handlers = (argv) => {
    if (argv[1] === '--version') return versionOk
    if (argv[1] !== 'download') return { ...versionOk, stdout: dryInfo }
    downloads.push(argv.slice())
    // Write real bytes, so "added" is measured rather than assumed.
    const dir = path.join(root, 'models--acme--gamma', 'snapshots', 'f'.repeat(40))
    put(path.join(dir, 'model.safetensors'), Buffer.alloc(7000, 7))
    return { ...versionOk, stdout: JSON.stringify([path.join(dir, 'model.safetensors')]) }
  }
  const { tools, calls } = harness({ HF_HUB_CACHE: root }, handlers)

  const over = await tool(tools, 'hf_download').execute({ repo: 'acme/gamma', maxBytes: 5_000_000 })
  check('a download over the ceiling is refused', over.view.code, 'TOO_BIG')
  check('...and NO download ran', downloads.length, 0)
  check('...and the size is in the sentence', over.text.includes(formatBytes(10_002_100)), true)

  const unconfirmed = await tool(tools, 'hf_download').execute({ repo: 'acme/gamma', maxBytes: 20_000_000 })
  check('an unconfirmed download is a PLAN', unconfirmed.view.code, 'NOT_CONFIRMED')
  check('...and NO download ran', downloads.length, 0)
  check('...and the plan names the size', unconfirmed.text.includes(formatBytes(10_002_100)), true)
  check('...and asks for the repo id back', unconfirmed.text.includes('confirm: "acme/gamma"'), true)

  const done = await tool(tools, 'hf_download').execute({ repo: 'acme/gamma', maxBytes: 20_000_000, confirm: 'acme/gamma' })
  check('a confirmed download runs ONE download', downloads.length, 1)
  check('...and reports the bytes the cache GAINED', done.view.addedBytes, 7000)
  check('...and the file that appeared', done.text.includes('model.safetensors'), true)
  check('...and the cache now holds it', existsSync(path.join(root, 'models--acme--gamma')), true)
  check('...with no token flag anywhere', calls.flat().includes('--token'), false)

  const gatedRepo = harness({ HF_HUB_CACHE: root }, () => ({ ...versionOk, stdout: JSON.stringify({ ...infoFixture, gated: 'manual' }) }))
  const refused = await tool(gatedRepo.tools, 'hf_download').execute({ repo: 'acme/gated', confirm: 'acme/gated' })
  check('a gated repo is refused before a byte moves', refused.view.code, 'GATED')
  check('...and the licence page is named', refused.text.includes('huggingface.co/'), true)

  const offline = harness({ HF_HUB_CACHE: root, HF_HUB_OFFLINE: '1' }, () => versionOk)
  const offlineRefused = await tool(offline.tools, 'hf_download').execute({ repo: 'acme/gamma', confirm: 'acme/gamma' })
  check('offline download is refused', offlineRefused.view.code, 'OFFLINE')
  check('...before any process starts', offline.calls.length, 0)
}

// ---------------------------------------------------------------------------
// The skills: registered, parsed, and their examples checked
// ---------------------------------------------------------------------------
const KNOWN_VERBS = new Set(['auth', 'buckets', 'cache', 'collections', 'cp', 'datasets', 'discussions', 'download', 'endpoints', 'env', 'extensions', 'jobs', 'models', 'papers', 'repos', 'sandbox', 'skills', 'spaces', 'sync', 'update', 'upload', 'version', 'webhooks'])
const skillTexts = []
for (const entry of SKILL_FILES) {
  const file = fileURLToPath(new URL(entry.file, import.meta.url))
  const raw = readFileSync(file, 'utf8')
  const { meta, content } = parseSkillFile(raw)
  skillTexts.push(content)
  check('skill ' + entry.name + ' is registered under its own name', meta.name, entry.name)
  check('skill ' + entry.name + ' has a description', typeof meta.description === 'string' && meta.description.length > 80, true)
  check('skill ' + entry.name + ' has a body', content.length > 500, true)
  check('skill ' + entry.name + ' has no token-shaped string', /hf_[A-Za-z0-9]{20,}/.test(raw), false)

  const blocks = [...raw.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)]
  let jsonBlocks = 0
  let commandLines = 0
  for (const block of blocks) {
    const lang = block[1]
    const body = block[2]
    if (lang === 'json') {
      jsonBlocks += 1
      try {
        JSON.parse(body)
        check('skill ' + entry.name + ': a JSON example parses', true)
      } catch (error) {
        check('skill ' + entry.name + ': a JSON example parses', false)
      }
      continue
    }
    if (lang !== 'bash' && lang !== 'sh') continue
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('hf ') && !trimmed.startsWith('huggingface-cli ')) continue
      commandLines += 1
      const tokens = trimmed.split(/\s+/)
      const verb = tokens[1] ?? ''
      if (verb.startsWith('-')) continue
      check('skill ' + entry.name + ': "' + verb + '" is a real verb', KNOWN_VERBS.has(verb))
    }
  }
  check('skill ' + entry.name + ' shows at least one command', commandLines > 0)
}
const allSkills = skillTexts.join('\n')
for (const name of ['hf_status', 'hf_search', 'hf_repo', 'hf_cache', 'hf_download']) {
  check('the skill set documents ' + name, allSkills.includes(name) || allSkills.includes(name.replace('hf_', 'hf ')), true)
}

// ---------------------------------------------------------------------------
// Activation: the row registers without a skill registry
// ---------------------------------------------------------------------------
{
  const registered = []
  const skills = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (entry) => registered.push(entry.name) },
    get: (name) => (name === 'skills' ? { register: (entry) => skills.push(entry.name) } : undefined),
    effect: (fn) => fn(),
  }
  apply(ctx)
  check('activation registers five tools', registered.length, 5)
  check('...all of them hf_*', registered.every((name) => name.startsWith('hf_')), true)
  check('...and two skills', skills.length, 2)
  check('the activation line names the cache root', __internals.activationLine({ env: { HF_HUB_CACHE: '/x' } }).includes(resolveCacheRoot({ HF_HUB_CACHE: '/x' }).root), true)

  const bare = { logger: { info() {}, warn() {} }, tools: { register() {} }, get: () => undefined, effect: (fn) => fn() }
  let threw = null
  try {
    apply(bare)
  } catch (error) {
    threw = error
  }
  check('the row activates with no skill registry', threw, null)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
check('bytes read as bytes', formatBytes(3100), '3.0 KB')
check('...and gigabytes', formatBytes(17_900_000_000), '16.7 GB')
check('...and a negative is not a number it invents', formatBytes(-1), 'n/a')
check('parameters read as parameters', formatParamCount(8_800_000_000), '8.8B')
check('...and millions', formatParamCount(418_000_000), '418M')

// ---------------------------------------------------------------------------
rmSync(root, { recursive: true, force: true })
console.log('')
console.log(checks + ' checks, ' + failures + ' failed' + (skipped > 0 ? ', ' + skipped + ' skipped' : ''))
if (failures > 0) process.exit(1)
