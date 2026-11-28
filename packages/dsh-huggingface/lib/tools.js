/**
 * dsh-huggingface — the five tools, and the verdict each one ends with.
 *
 * The row exists for ONE question a person asks before committing disk and
 * bandwidth: *what am I about to download, and do I already have it?* Every
 * answer therefore ends in a verdict rather than a wall of metadata:
 *
 *   - `hf_status` counts what is on this disk and separates COMPLETE repos from
 *     the metadata-only stubs that look identical in a directory listing;
 *   - `hf_search` is a ranked list, with the licence and gated flag a download
 *     would need first;
 *   - `hf_repo` is the decision: weight, licence, gated status, which files a
 *     consumer would actually fetch, and whether the local copy is complete and
 *     at the CURRENT revision;
 *   - `hf_cache` lists, verifies, and removes - an unconfirmed removal is the
 *     CLI's own --dry-run, and a confirmed one needs the target repeated back;
 *   - `hf_download` is the only call that moves bytes: a projected size first, a
 *     ceiling it will not cross, then the repo id repeated back, and afterwards
 *     the bytes the cache actually GAINED.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { HfError, messageOf } from './errors.js'
import { CAPS, validateCache, validateDownload, validateRepo, validateSearch } from './validate.js'
import { describeRepoDir, repoDirName, scanCache } from './cache.js'
import { estimateVram, modelFields, readCheckpoint } from './model.js'
import { offlineOf, resolveCacheRoot, tokenPresence } from './paths.js'
import { resolveCli } from './cli.js'
import {
  buildCacheArgv,
  buildDownloadArgv,
  buildInfoArgv,
  buildSearchArgv,
  callCli,
  consumersOf,
  normalizeInfo,
  parseDownloadAnswer,
  projectDownload,
  runHf,
} from './hf.js'

/** The output shape every tool returns: prose for the model, a view for the card. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, view: { type: 'object' } },
    required: ['text', 'view'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => value.view,
}

/** A card for the transcript. */
function present(title) {
  return {
    presentCall: () => ({ card: 'generic', title: title, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: title, content: result && result.text ? result.text : '' }),
  }
}

/** A refusal: a sentence, and a view a caller can branch on. */
function refusal(code, message, extra) {
  return { text: message, view: { ok: false, code: code, ...(extra ?? {}) } }
}

/** The same refusal for any thrown failure. */
function failureOf(error) {
  if (error instanceof HfError) return refusal(error.code, error.message, error.details)
  return refusal('FAILED', error && error.message ? String(error.message) : String(error))
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
/** Bytes as a reader reads them. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a'
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index]
}

/** A count with thousands separators. */
export function formatCount(value) {
  return Number.isFinite(value) ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'n/a'
}

/** Pad a column, clipping it to its width. */
function cell(value, width) {
  const text = String(value === undefined || value === null ? '' : value)
  const cut = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '\u2026' : text
  return cut.padEnd(width)
}

/** A fixed-width table. */
function table(headers, rows) {
  if (rows.length === 0) return headers.join('  ')
  const widths = headers.map((header, index) => Math.min(46, Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))))
  const line = (cells) => cells.map((value, index) => cell(value, widths[index])).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

/** A date, or the raw ISO slice. */
function dayOf(iso) {
  const text = String(iso ?? '')
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

/** One repo's local state, without scanning every repo in the cache. */
function localState(root, type, id) {
  const directory = repoDirName(type, id)
  if (directory === null) return null
  const entry = describeRepoDir(root, directory)
  if (entry === null) return null
  return { dir: entry.path, bytes: entry.bytes, files: entry.files, revision: entry.revision, weights: entry.weights, stub: entry.stub, layout: entry.layout, modifiedMs: entry.modifiedMs }
}

/** The local verdict for one repo against the Hub's current revision. */
function localVerdict(local, hubSha) {
  if (local === null) return { state: 'absent', label: 'not cached on this machine' }
  if (local.stub) {
    return { state: 'stub', label: 'cached, but METADATA ONLY (' + formatBytes(local.bytes) + ', no weight file) - it cannot be loaded' }
  }
  const stale = hubSha !== '' && local.revision !== '' && hubSha !== local.revision
  if (stale) {
    return { state: 'stale', label: 'cached at ' + local.revision.slice(0, 12) + ', but the Hub\'s current revision is ' + hubSha.slice(0, 12) + ' - a load would fetch the difference' }
  }
  return { state: 'complete', label: 'cached and complete (' + formatBytes(local.bytes) + ')' }
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------
/** A repo's weight, with the measure that produced it. */
export function weightLine(info) {
  if (info.sizesComplete) return formatBytes(info.totalBytes) + ' in ' + info.files.length + ' file(s)'
  if (info.totalSource === 'hub storage') {
    return formatBytes(info.totalBytes) + ' on the Hub (used_storage: the whole repo, every file and revision - this CLI reports no per-file sizes)'
  }
  if (info.totalSource === 'file sizes') return formatBytes(info.totalBytes) + ' in ' + info.files.length + ' file(s) (LOWER BOUND: ' + info.unknownSizes + ' had no reported size)'
  return 'size not reported'
}

/**
 * What the cached checkpoint would cost to LOAD, or why it cannot be said.
 *
 * Only files on disk are read: a repo that is not cached, or is metadata only,
 * has no weight bytes to size, and inventing them from the Hub's figure would be
 * a claim about a model nobody has.
 *
 * @returns `{ available, reason?, fields?, estimate? }` or null when there is no
 *   local checkpoint at all.
 */
export function fitOf(local, spec, options = {}) {
  if (local === null || typeof local.dir !== 'string') return null
  if (local.stub === true || local.weights === false) {
    return { available: false, reason: 'this copy is metadata only - there are no weight files to size' }
  }
  // A cache repo's root holds `snapshots/<rev>/`; a local checkout holds the
  // files directly. The config and the weights live in the SNAPSHOT, so that is
  // what is read - the root would find neither.
  const snapshot = typeof local.revision === 'string' && local.revision !== '' ? path.join(local.dir, 'snapshots', local.revision) : null
  const target = snapshot !== null && existsSync(path.join(snapshot, 'config.json')) ? snapshot : local.dir
  const checkpoint = readCheckpoint(target)
  if (checkpoint.config === null) {
    return { available: false, reason: checkpoint.warnings[0] ?? 'no config.json in this snapshot, so the attention heads are unknown' }
  }
  const fields = modelFields(checkpoint.config)
  const wanted = String(options.dtype ?? 'auto').toLowerCase()
  // Order matters: what the FILE holds beats what the config claims, because the
  // bytes-per-parameter is the divisor for the parameter count and the KV size.
  const dtype = wanted === 'auto' ? checkpoint.fileDtype || fields.torchDtype || 'float16' : options.dtype
  const dtypeSource = wanted !== 'auto' ? 'asked for' : checkpoint.fileDtype !== '' ? 'from the safetensors header' : fields.torchDtype !== '' ? 'from config.json' : 'defaulted to fp16'
  const contexts = Array.isArray(options.contexts) && options.contexts.length > 0 ? options.contexts : [4096, 8192, 32768]
  const estimate = estimateVram({ weightsBytes: checkpoint.weightsBytes, fields, dtype, contexts })
  return { available: true, fields, estimate, weightsBytes: checkpoint.weightsBytes, dtypeSource, warnings: checkpoint.warnings }
}

/** The fit section, as lines - shared by the online and offline answers. */
export function fitLines(fit, freeBytes) {
  const lines = []
  if (fit === null || fit.available !== true) {
    lines.push('Fit: not estimated - ' + (fit !== null && fit.reason ? fit.reason : 'nothing on disk to size') + '.')
    return lines
  }
  const estimate = fit.estimate
  const free = typeof freeBytes === 'number' && Number.isFinite(freeBytes) ? freeBytes : null
  lines.push('Fit - from the ' + formatBytes(fit.weightsBytes) + ' of weights on disk, no model loaded:')
  const facts = []
  if (estimate.params !== null) facts.push('~' + formatParamCount(estimate.params) + ' params at ' + estimate.dtype + (fit.dtypeSource ? ' (' + fit.dtypeSource + ')' : ''))
  if (estimate.kvKnown) facts.push('KV ' + formatBytes(estimate.kvPerToken) + '/token')
  if (facts.length > 0) lines.push('  ' + facts.join(' \u00b7 '))
  if (!estimate.kvKnown) lines.push('  KV cache: UNKNOWN - this config does not state its attention heads, so only the weights are sized')
  lines.push('  allowance: ' + formatBytes(estimate.overhead) + ' (activations and fragmentation: 10% of the weights, with a 512 MB floor)')
  if (estimate.vram.length > 0) {
    const headers = ['CONTEXT', 'WEIGHTS', 'KV CACHE', 'TOTAL']
    if (free !== null) headers.push('FITS ' + formatBytes(free))
    lines.push(
      table(
        headers,
        estimate.vram.map((row) => {
          const cells = [String(row.context), formatBytes(row.weights), formatBytes(row.kv), formatBytes(row.total)]
          if (free !== null) cells.push(row.total <= free ? 'yes' : 'NO')
          return cells
        }),
      ),
    )
    if (free !== null) {
      const fitting = estimate.vram.filter((row) => row.total <= free)
      lines.push(fitting.length > 0 ? '  largest context that fits ' + formatBytes(free) + ': ' + fitting[fitting.length - 1].context : '  none of these fits in ' + formatBytes(free) + ': a smaller dtype or a shorter context is the answer')
    }
  }
  return lines
}

/** Build the tools. @param deps - `{ env, runner, now, cache, log }`. */
export function buildTools(deps) {
  /** `hf_status`: what is here, without touching the network. */
  const status = {
    name: 'hf_status',
    description: [
      'Report the Hugging Face surface on THIS machine: whether the `hf` CLI is on PATH and which version it is, where the cache lives (and which variable chose it), every repo already downloaded with its BYTE-EXACT size, and - the part a directory listing cannot tell you - which of those repos are COMPLETE and which are metadata-only stubs that cannot be loaded.',
      'Call this FIRST. It starts no download and makes no network request: it reads the cache directory, the environment and one `hf --version`.',
      'Auth is reported as a PRESENCE only ("a token is set (stored token file)"), because the token is a credential: this tool never reads, echoes or logs it, and `hf auth whoami` is the command that names the account.',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    ...present('Hugging Face status'),
    async execute() {
      try {
        const cacheRoot = resolveCacheRoot(deps.env)
        const scan = scanCache(cacheRoot.root)
        const cli = await resolveCli(deps)
        const offline = offlineOf(deps.env)
        const token = tokenPresence(deps.env, existsSync(path.join(cacheRoot.root, '..', 'token')))
        const largest = scan.repos.slice(0, 5)
        const stubs = scan.repos.filter((repo) => repo.stub)

        const lines = []
        lines.push('Hugging Face CLI: ' + (cli.bin === null ? 'none on this PATH (install `pip install -U huggingface_hub`; the cache scan still works)' : cli.bin + ' ' + (cli.version === '' ? '(version not reported)' : cli.version) + ' (' + cli.source + ')'))
        lines.push('Cache: ' + cacheRoot.root + ' (from ' + cacheRoot.from + (cacheRoot.deprecated ? ', DEPRECATED variable' : '') + ')')
        if (!scan.exists) {
          lines.push('  the directory does not exist: nothing has been downloaded here yet.')
        } else {
          lines.push('  ' + scan.counts.repos + ' repo(s), ' + formatBytes(scan.counts.bytes) + ' on disk')
          lines.push('  ' + scan.counts.complete + ' complete \u00b7 ' + scan.counts.stubs + ' metadata only (no weight file)')
          const byType = Object.entries(scan.counts.byType).map(([type, count]) => count + ' ' + type + (count === 1 ? '' : 's')).join(' \u00b7 ')
          if (byType !== '') lines.push('  ' + byType)
          if (largest.length > 0) {
            lines.push('')
            lines.push(table(['LARGEST', 'TYPE', 'SIZE', 'FILES', 'UPDATE FILE'], largest.map((repo) => [repo.id, repo.type, formatBytes(repo.bytes), String(repo.files), repo.stub ? 'none' : 'yes'])))
          }
          if (stubs.length > 0) {
            lines.push('')
            lines.push('Metadata only - these look present and cannot be loaded (' + stubs.length + '):')
            for (const repo of stubs.slice(0, 10)) lines.push('  ' + repo.id + ' (' + repo.type + ', ' + formatBytes(repo.bytes) + ')')
            if (stubs.length > 10) lines.push('  ... and ' + (stubs.length - 10) + ' more; `hf_cache` action "list" shows all')
            lines.push('A load of one of these would go to the network. `hf_repo` says what it would weigh.')
          }
        }
        lines.push('')
        lines.push('Auth: ' + (token.present ? 'a token is set (' + token.source + ') - never read or echoed here; `hf auth whoami` names the account' : 'no token set - public repos work, gated and private ones need `hf auth login`'))
        lines.push('Offline: ' + (offline ? 'yes (HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE is set) - search, info and download will refuse' : 'no'))
        lines.push('')
        lines.push('Next: `hf_repo` for one repo\'s weight, licence and local state; `hf_search` to find one; `hf_cache` to verify or reclaim space; `hf_download` to fetch (it reports the size first).')
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            cli: { bin: cli.bin, version: cli.version, source: cli.source },
            cache: { root: cacheRoot.root, from: cacheRoot.from, deprecated: cacheRoot.deprecated, exists: scan.exists, counts: scan.counts },
            largest: largest.map((repo) => ({ id: repo.id, type: repo.type, bytes: repo.bytes, stub: repo.stub })),
            stubs: stubs.map((repo) => ({ id: repo.id, type: repo.type, bytes: repo.bytes })),
            auth: token,
            offline,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `hf_search`: ranked ids, with the flags a download needs. */
  const search = {
    name: 'hf_search',
    description: [
      'Search the Hub for models, datasets or spaces: a free-text `query`, an `author` (org or user), tag `filters`, a `sort` key (downloads, likes, last_modified, created_at, trending_score) and a `limit` up to 50.',
      'It returns ids with downloads, likes, last update, pipeline tag and library - the ranking columns, so the choice is made on evidence. It does NOT download anything.',
      'A machine in offline mode (HF_HUB_OFFLINE=1) is refused with the variable that turns it off, because a search with no network can only fail.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Free text, e.g. "qwen3 8b" or "whisper large". Omit to list by sort order.' },
        type: { type: 'string', enum: ['model', 'dataset', 'space'], description: 'Which repo kind to search. Default model.' },
        limit: { type: 'integer', description: 'How many results: 1-50. Default 10.' },
        author: { type: 'string', description: 'An org or user name, e.g. "Qwen" or "sentence-transformers".' },
        filters: { type: 'array', items: { type: 'string' }, description: 'Tag filters, e.g. ["text-generation"] or ["license:apache-2.0"]. At most 5.' },
        sort: { type: 'string', enum: ['created_at', 'downloads', 'last_modified', 'likes', 'trending_score'], description: 'Ranking key.' },
      },
    },
    output: OUTPUT,
    ...present('Hugging Face search'),
    async execute(args) {
      try {
        if (offlineOf(deps.env)) {
          return refusal('OFFLINE', 'This machine is in offline mode (' + (deps.env.HF_HUB_OFFLINE === '1' ? 'HF_HUB_OFFLINE=1' : 'TRANSFORMERS_OFFLINE=1') + '), so a Hub search cannot answer. Unset it for the search, or use `hf_cache` and `hf_repo` on what is already on disk.')
        }
        const spec = validateSearch(args)
        const answer = await runHf(deps, buildSearchArgv, spec, { timeoutMs: CAPS.readTimeoutMs })
        const results = Array.isArray(answer.data) ? answer.data : Array.isArray(answer.data?.models) ? answer.data.models : []
        const rows = results.slice(0, spec.limit).map((entry) => {
          const body = entry !== null && typeof entry === 'object' ? entry : {}
          return {
            id: typeof body.id === 'string' ? body.id : typeof body.modelId === 'string' ? body.modelId : '',
            downloads: typeof body.downloads === 'number' ? body.downloads : null,
            likes: typeof body.likes === 'number' ? body.likes : null,
            // MEASURED: `hf models list` answers `created_at`, not `lastModified`.
            created: dayOf(body.createdAt ?? body.created_at ?? body.lastModified),
            task: typeof body.pipeline_tag === 'string' ? body.pipeline_tag : '',
            library: typeof body.library_name === 'string' ? body.library_name : '',
            gated: body.gated === true || body.gated === 'auto' || body.gated === 'manual' ? String(body.gated) : '',
          }
        }).filter((entry) => entry.id !== '')
        const lines = []
        const what = spec.query === '' ? 'the Hub' : '"' + spec.query + '"'
        lines.push(rows.length + ' ' + spec.type + '(s) for ' + what + (spec.sort === '' ? '' : ', sorted by ' + spec.sort) + (spec.author === '' ? '' : ', author ' + spec.author))
        if (rows.length === 0) {
          lines.push('')
          lines.push('Nothing matched. A Hub search is exact about the query: try fewer words, or drop the `filters`.')
        } else {
          lines.push(table(['ID', 'DOWNLOADS', 'LIKES', 'CREATED', 'TASK', 'LIB'], rows.map((entry) => [entry.id, formatCount(entry.downloads), formatCount(entry.likes), entry.created, entry.task, entry.library])))
        }
        lines.push('')
        lines.push('Next: `hf_repo` on an id gives the licence, the gated flag, the file sizes and whether this disk already has it. Nothing was downloaded.')
        return { text: lines.join('\n'), view: { ok: true, type: spec.type, query: spec.query, count: rows.length, results: rows } }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `hf_repo`: the download decision, one repo at a time. */
  const repo = {
    name: 'hf_repo',
    description: [
      'Describe ONE Hub repo before anything is fetched: licence, gated status (and the page that accepts it), downloads and likes, the architecture and parameter count when the card reports them, the file list, the repo weight AS THE HUB REPORTS IT, which files each CONSUMER would actually fetch (transformers, sentence-transformers, diffusers, llama.cpp/Ollama quants, ONNX), and whether THIS machine already holds it - complete, metadata-only, at an older revision, or absent.',
      'For a repo that IS cached, it goes one step further and answers the question the download size only half-answers: WILL IT FIT. It reads the cached `config.json` and the weight files and reports the parameters those bytes imply plus the KV-cache arithmetic - `2 x layers x kv_heads x head_dim x dtype_bytes` PER TOKEN - as a table of context lengths against total VRAM. Pass `freeBytes` (what your GPU has free) and each row says FITS or not; pass `contexts` to choose the lengths. No model is loaded, so the answer costs nothing.',
      'This is the tool that answers "how big is it, do I already have it, and can I run it" without downloading a byte. MEASURED: this CLI line gives no per-file sizes (its `--expand siblings` carries only names), so the weight is the Hub\'s `used_storage` - labelled as such rather than summed from files that were never sized. The FIT estimate is the opposite: it is read from the files on disk, and is absent rather than guessed when the repo is not cached.',
      'With no network (or in offline mode) it reports what is on disk and says the Hub side was not asked.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['repo'],
      properties: {
        repo: { type: 'string', description: 'A Hub id as `org/name`, e.g. "sentence-transformers/all-mpnet-base-v2".' },
        type: { type: 'string', enum: ['model', 'dataset', 'space'], description: 'Repo kind. Default model.' },
        revision: { type: 'string', description: 'A branch, tag or commit to describe instead of the default branch.' },
        freeBytes: { type: 'number', description: 'VRAM you actually have free, in bytes. Each fit row then says FITS or not. Omit and the sizes are reported without a verdict.' },
        contexts: { type: 'array', items: { type: 'number' }, description: 'Context lengths to size, up to 6. Default 4096, 8192, 32768.' },
        dtype: { type: 'string', enum: ['auto', 'bf16', 'fp16', 'fp32'], description: 'The dtype a load would use. Default: what config.json says, else fp16.' },
      },
    },
    output: OUTPUT,
    ...present('Hugging Face repo'),
    async execute(args) {
      try {
        const spec = validateRepo(args)
        const cacheRoot = resolveCacheRoot(deps.env)
        const local = localState(cacheRoot.root, spec.type, spec.repo)
        const fit = fitOf(local, spec, { dtype: args.dtype, contexts: args.contexts })
        const offline = offlineOf(deps.env)
        if (offline) {
          const verdict = localVerdict(local, '')
          const lines = [spec.repo + ' (' + spec.type + ') - offline, so the Hub side was not asked', '', 'Local: ' + verdict.label]
          if (local !== null) {
            lines.push('  ' + formatBytes(local.bytes) + ' in ' + local.files + ' file(s), revision ' + (local.revision === '' ? 'unknown' : local.revision.slice(0, 12)) + ', layout ' + local.layout)
            if (local.weights === false) lines.push('  No weight file is present: this copy cannot be loaded, and a load would need the network this machine has turned off.')
          }
          if (fit !== null) {
            lines.push('')
            lines.push(...fitLines(fit, args.freeBytes))
          }
          lines.push('')
          lines.push('Unset HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE to ask the Hub about the licence, sizes and current revision.')
          return { text: lines.join('\n'), view: { ok: true, offline: true, repo: { id: spec.repo, type: spec.type }, local: { ...verdict, entry: local }, fit } }
        }
        const answer = await runHf(deps, buildInfoArgv, spec, { timeoutMs: CAPS.readTimeoutMs })
        const info = normalizeInfo(answer.data, spec)
        const verdict = localVerdict(local, info.sha)
        const consumers = consumersOf(info.files)
        const gatedUrl = 'https://huggingface.co/' + (spec.type === 'dataset' ? 'datasets/' : spec.type === 'space' ? 'spaces/' : '') + spec.repo

        const lines = []
        lines.push(info.repo + ' (' + spec.type + ')' + (info.architectures.length > 0 ? ' \u00b7 ' + info.architectures[0] : info.modelType !== '' ? ' \u00b7 ' + info.modelType : '') + (info.licence === '' ? ' \u00b7 licence not stated' : ' \u00b7 ' + info.licence))
        const facts = []
        if (info.params !== null) facts.push(formatParamCount(info.params) + ' params')
        if (info.contextLength !== null) facts.push('context ' + formatCount(info.contextLength))
        if (info.pipelineTag !== '') facts.push(info.pipelineTag)
        if (info.library !== '') facts.push(info.library)
        if (facts.length > 0) lines.push('  ' + facts.join(' \u00b7 '))
        lines.push('  ' + weightLine(info))
        const popularity = []
        if (info.downloads !== null) popularity.push(formatCount(info.downloads) + ' downloads')
        if (info.likes !== null) popularity.push(formatCount(info.likes) + ' likes')
        const modified = dayOf(info.lastModified)
        if (modified !== '') popularity.push('modified ' + modified)
        if (popularity.length > 0) lines.push('  ' + popularity.join(' \u00b7 '))
        if (info.gated !== '') lines.push('  GATED (' + info.gated + '): a person must accept the licence first - ' + gatedUrl)
        if (info.private) lines.push('  PRIVATE: needs a token with access.')
        lines.push('')
        lines.push('Local: ' + verdict.label)
        if (verdict.state === 'complete' && local !== null) lines.push('  revision ' + local.revision.slice(0, 12) + ' \u00b7 layout ' + local.layout + ' \u00b7 ' + local.files + ' file(s)')
        if (fit !== null) {
          lines.push('')
          lines.push(...fitLines(fit, args.freeBytes))
        }
        if (consumers.length > 0) {
          lines.push('')
          lines.push('What a consumer would fetch:')
          for (const consumer of consumers) {
            const shown = consumer.files.slice(0, 6).join(', ')
            const more = consumer.files.length > 6 ? ', +' + (consumer.files.length - 6) + ' more' : ''
            lines.push('  ' + consumer.consumer + ': ' + shown + more)
            lines.push('    ' + consumer.note)
          }
        }
        const biggest = info.files.filter((file) => file.bytes !== null).sort((left, right) => right.bytes - left.bytes).slice(0, CAPS.maxFilesListed)
        if (biggest.length > 0) {
          lines.push('')
          lines.push(table(['FILE', 'SIZE'], biggest.map((file) => [file.name, formatBytes(file.bytes)])))
          if (info.files.length > biggest.length) lines.push('... ' + (info.files.length - biggest.length) + ' smaller file(s)')
        } else if (info.files.length > 0) {
          lines.push('')
          lines.push(info.files.length + ' file(s): ' + info.files.slice(0, 8).map((file) => file.name).join(', ') + (info.files.length > 8 ? ', ...' : ''))
          lines.push('This CLI reports no per-file sizes, so narrow a download by `files` or `include` rather than by measurement.')
        }
        lines.push('')
        lines.push(verdict.state === 'absent' ? 'Next: `hf_download` to fetch it - it reports this size and needs the repo id repeated back' : 'Next: `hf_cache` action "verify" to check the local bytes, or `hf_download` to fetch what is missing')
        return {
          text: lines.join('\n'),
          view: {
            ok: true,
            offline: false,
            repo: {
              id: info.repo,
              type: info.type,
              sha: info.sha,
              licence: info.licence,
              gated: info.gated,
              private: info.private,
              downloads: info.downloads,
              likes: info.likes,
              pipelineTag: info.pipelineTag,
              library: info.library,
              architectures: info.architectures,
              modelType: info.modelType,
              contextLength: info.contextLength,
              params: info.params,
              bytes: info.totalBytes,
              sizesComplete: info.sizesComplete,
              files: info.files,
            },
            local: { ...verdict, entry: local },
            fit,
            consumers,
          },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `hf_cache`: list, verify, and reclaim - never silently. */
  const cache = {
    name: 'hf_cache',
    description: [
      'Work the cache on THIS disk: `action: "list"` (the default) scans it without any CLI or network and reports every repo with its exact bytes, file count, whether it holds a weight file, and its revision; `verify` asks the CLI to checksum one repo revision; `prune` removes detached revisions and incomplete downloads; `rm` removes one repo.',
      'NEITHER REMOVAL HAPPENS WITHOUT `confirm`: `rm` wants the repo id repeated back, `prune` wants the word "prune". Without it the call runs the CLI\'s own `--dry-run` and reports what WOULD be freed - a real preview, not prose about one.',
      'This is the only place a gigabyte is reclaimed, and it is also the place that names the metadata-only stubs: entries that look cached, weigh a few KB, and cannot be loaded.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'verify', 'prune', 'rm'], description: 'Default list.' },
        repo: { type: 'string', description: 'For verify and rm: the repo id as `org/name`.' },
        type: { type: 'string', enum: ['model', 'dataset', 'space'], description: 'Repo kind for repo/verify/rm, and a filter for list. Default model.' },
        revision: { type: 'string', description: 'For verify: the revision to check. Default main.' },
        confirm: { type: 'string', description: 'The repo id (for rm) or the word "prune", repeated back. Without it the call is a dry run.' },
        filter: { type: 'string', description: 'For list: only ids containing this text.' },
        limit: { type: 'integer', description: 'For list: how many rows, 1-500. Default 100.' },
      },
    },
    output: OUTPUT,
    ...present('Hugging Face cache'),
    async execute(args) {
      try {
        const spec = validateCache(args)
        const cacheRoot = resolveCacheRoot(deps.env)
        if (spec.action === 'list') {
          const scan = scanCache(cacheRoot.root, { type: spec.type === '' ? undefined : spec.type, filter: spec.filter, limit: spec.limit })
          const lines = []
          lines.push('Cache ' + cacheRoot.root + ' (from ' + cacheRoot.from + ')')
          if (!scan.exists) {
            lines.push('  the directory does not exist: nothing has been downloaded here yet.')
            lines.push('')
            lines.push('`hf_download` writes here; nothing is there to verify or remove.')
            return { text: lines.join('\n'), view: { ok: true, root: cacheRoot.root, exists: false, counts: scan.counts, repos: [] } }
          }
          const shown = scan.repos
          lines.push('  ' + scan.counts.repos + ' repo(s), ' + formatBytes(scan.counts.bytes) + ' \u00b7 ' + scan.counts.complete + ' complete \u00b7 ' + scan.counts.stubs + ' metadata only')
          if (scan.limited) lines.push('  showing ' + shown.length + ' (limit ' + spec.limit + ')')
          if (shown.length === 0) lines.push('  no repo matched.')
          else {
            lines.push('')
            lines.push(table(['ID', 'TYPE', 'SIZE', 'FILES', 'WEIGHTS', 'REVISION'], shown.map((entry) => [entry.id, entry.type, formatBytes(entry.bytes), String(entry.files), entry.weights ? 'yes' : 'NO', entry.revision === '' ? 'n/a' : entry.revision.slice(0, 8)])))
          }
          lines.push('')
          if (scan.counts.stubs > 0) lines.push(scan.counts.stubs + ' entries hold no weight file - they cannot be loaded. `hf_cache` action "rm" with the id repeated back removes one; `hf_repo` says what a real download would weigh.')
          lines.push('Reclaim space with `hf_cache` action "prune" (confirm "prune") or "rm" (confirm the repo id); both are dry runs without it.')
          return { text: lines.join('\n'), view: { ok: true, root: cacheRoot.root, from: cacheRoot.from, exists: true, counts: scan.counts, repos: shown } }
        }

        if (spec.action === 'verify') {
          const answer = await runHf(deps, buildCacheArgv, spec, { timeoutMs: CAPS.downloadTimeoutMs })
          const body = answer.data !== null && typeof answer.data === 'object' ? answer.data : {}
          const lines = []
          lines.push('Verified ' + spec.repo + (spec.revision === '' ? '' : ' at ' + spec.revision) + ' in ' + Math.round(answer.elapsedMs / 100) / 10 + ' s')
          for (const [key, value] of Object.entries(body)) {
            if (key === 'repo_id' || key === 'id') continue
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') lines.push('  ' + key + ': ' + value)
            if (Array.isArray(value)) lines.push('  ' + key + ': ' + (value.length === 0 ? 'none' : value.length + ' entry/entries'))
          }
          lines.push('')
          lines.push('A checksum verdict is the CLI\'s own: "OK" means the bytes match the Hub\'s, and any mismatch is listed above.')
          return { text: lines.join('\n'), view: { ok: true, repo: spec.repo, revision: spec.revision, report: body } }
        }

        // prune / rm
        const target = spec.action === 'prune' ? 'detached revisions and incomplete downloads' : spec.repo
        const before = spec.action === 'rm' ? localState(cacheRoot.root, spec.type, spec.repo) : null
        const confirmed = spec.confirm === (spec.action === 'prune' ? 'prune' : spec.repo)
        const answer = await runHf(deps, buildCacheArgv, spec, { timeoutMs: CAPS.downloadTimeoutMs })
        const after = spec.action === 'rm' ? localState(cacheRoot.root, spec.type, spec.repo) : null
        const freed = before !== null && before.bytes > 0 ? before.bytes - (after === null ? 0 : after.bytes) : 0
        const lines = []
        if (!confirmed) {
          lines.push('DRY RUN - nothing was removed.')
          lines.push('')
          lines.push('Would ' + (spec.action === 'prune' ? 'prune ' + target : 'remove ' + target + (before === null ? ' (not in the cache)' : ' (' + formatBytes(before.bytes) + ')')) + '.')
          if (before !== null) lines.push('That repository holds ' + formatBytes(before.bytes) + ' in ' + before.files + ' file(s); a re-download costs exactly that.')
          lines.push('')
          lines.push('To do it, call again with `confirm: "' + (spec.action === 'prune' ? 'prune' : spec.repo) + '"`.')
        } else {
          lines.push('Removed ' + target + (freed > 0 ? ' - ' + formatBytes(freed) + ' reclaimed' : '') + '.')
          if (freed === 0 && spec.action === 'rm') lines.push('The directory is gone; the byte total could not be measured from this cache layout.')
          lines.push('')
          lines.push('The Hub copy is untouched: `hf_download` can restore it, and `hf_repo` will report its size again.')
        }
        return {
          text: lines.join('\n'),
          view: { ok: true, action: spec.action, repo: spec.repo === '' ? null : spec.repo, confirmed, freedBytes: freed, cli: answer.data, before, after },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  /** `hf_download`: the one call that moves bytes. */
  const download = {
    name: 'hf_download',
    description: [
      'Download one Hub repo into the local cache - the only call in this row that moves bytes, and the only one that needs the repo id repeated back as `confirm`.',
      'It reports the weight the Hub gives for the repo FIRST and refuses a download larger than `maxBytes` (8 GiB by default) rather than starting one; then it refuses without `confirm`; then it fetches, and answers with the bytes the cache actually GAINED, the files, and the elapsed time.',
      'Narrow it with `files` (repo-relative paths) or `include` / `exclude` globs - `*` stays inside a segment, `**` crosses them - because a repo often ships four quantizations and a tokenizer you already have. A narrowed selection cannot be measured on this CLI line (no per-file sizes), and the plan says so instead of guessing. It never accepts or echoes a token: authentication is the CLI\'s own (`hf auth login`).',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['repo'],
      properties: {
        repo: { type: 'string', description: 'A Hub id as `org/name`.' },
        type: { type: 'string', enum: ['model', 'dataset', 'space'], description: 'Repo kind. Default model.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to fetch. At most 200; use include for more.' },
        include: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to include, e.g. ["*.safetensors", "*.json"].' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to skip, e.g. ["*.gguf", "*.onnx"].' },
        revision: { type: 'string', description: 'A branch, tag or commit. Default the repo\'s default branch.' },
        maxBytes: { type: 'number', description: 'The ceiling this call will not cross, in bytes. 1 MiB - 1 TiB. Default 8 GiB.' },
        confirm: { type: 'string', description: 'The repo id, repeated back. Without it the call reports the plan and downloads nothing.' },
      },
    },
    output: OUTPUT,
    ...present('Hugging Face download'),
    async execute(args) {
      try {
        if (offlineOf(deps.env)) {
          return refusal('OFFLINE', 'This machine is in offline mode (' + (deps.env.HF_HUB_OFFLINE === '1' ? 'HF_HUB_OFFLINE=1' : 'TRANSFORMERS_OFFLINE=1') + '), so nothing can be downloaded. Unset it for this call.')
        }
        const spec = validateDownload(args)
        const cacheRoot = resolveCacheRoot(deps.env)
        const infoAnswer = await runHf(deps, buildInfoArgv, spec, { timeoutMs: CAPS.readTimeoutMs })
        const info = normalizeInfo(infoAnswer.data, spec)
        if (info.gated !== '' && info.gated !== 'false') {
          return refusal('GATED', info.repo + ' is gated (' + info.gated + '): a person has to accept its licence in a browser before any token can fetch it - https://huggingface.co/' + (spec.type === 'dataset' ? 'datasets/' : spec.type === 'space' ? 'spaces/' : '') + info.repo + '\n\nNothing was downloaded.', { repo: info.repo, gated: info.gated })
        }
        const plan = projectDownload(info, spec)
        if (plan.files.length === 0) {
          return refusal('BAD_INPUT', 'No file in ' + info.repo + ' matches that selection (' + [...spec.files, ...spec.include].join(', ') + '). `hf_repo` lists what the repo actually contains.', { repo: info.repo, files: info.files.map((file) => file.name).slice(0, 40) })
        }
        if (plan.bytes !== null && plan.bytes > spec.maxBytes) {
          return refusal('TOO_BIG', 'That selection weighs ' + formatBytes(plan.bytes) + ', over the ' + formatBytes(spec.maxBytes) + ' ceiling for this call. Nothing was downloaded.\n\nEither narrow it with `files` / `include` / `exclude`, or raise the ceiling with `maxBytes` - deliberately, with the size in hand.', { repo: info.repo, bytes: plan.bytes, ceiling: spec.maxBytes, measured: plan.measured })
        }
        if (spec.confirm !== spec.repo) {
          const lines = []
          lines.push('PLAN - nothing was downloaded.')
          lines.push('')
          lines.push('  repo:      ' + info.repo + ' (' + info.type + ')')
          lines.push('  files:     ' + plan.files.length + ' of ' + info.files.length)
          if (plan.bytes === null) {
            lines.push('  size:      not measured for this selection: this CLI reports no per-file sizes')
            lines.push('             the whole repo is ' + (info.totalBytes > 0 ? formatBytes(info.totalBytes) + ' (used_storage)' : 'also unreported'))
            lines.push('  ceiling:   ' + formatBytes(spec.maxBytes) + ' - applies only to a measured size, so narrow the selection or pass `maxBytes` knowingly')
          } else {
            lines.push('  size:      ' + formatBytes(plan.bytes) + (plan.measured === 'repo' ? ' (the whole repo, per the Hub)' : plan.measured === 'lower-bound' ? ' (at least - some sizes were not reported)' : ' (' + plan.files.length + ' measured file(s))'))
            lines.push('  ceiling:   ' + formatBytes(spec.maxBytes) + ' - within it')
          }
          lines.push('  cache:     ' + cacheRoot.root)
          const local = localState(cacheRoot.root, spec.type, spec.repo)
          if (local !== null) lines.push('  already:   ' + formatBytes(local.bytes) + (local.stub ? ' (metadata only)' : '') + ' - the difference is what downloads')
          lines.push('')
          lines.push('To fetch it, call again with `confirm: "' + spec.repo + '"`.')
          return refusal('NOT_CONFIRMED', lines.join('\n'), { repo: info.repo, plan, ceiling: spec.maxBytes })
        }
        const before = localState(cacheRoot.root, spec.type, spec.repo)
        const answer = await runHf(deps, buildDownloadArgv, spec, { timeoutMs: CAPS.downloadTimeoutMs, allowLoose: true })
        const parsed = parseDownloadAnswer(answer.data)
        const after = localState(cacheRoot.root, spec.type, spec.repo)
        const added = (after === null ? 0 : after.bytes) - (before === null ? 0 : before.bytes)
        const lines = []
        lines.push('Downloaded ' + info.repo + ': ' + parsed.paths.length + ' file(s) reported, ' + formatBytes(Math.max(0, added)) + ' added to the cache in ' + Math.round(answer.elapsedMs / 100) / 10 + ' s')
        lines.push('  cache now: ' + (after === null ? 'no directory was created' : formatBytes(after.bytes) + ' in ' + after.files + ' file(s)' + (after.weights ? ', with a weight file' : ', STILL no weight file')))
        if (parsed.paths.length > 0) {
          lines.push('')
          for (const entry of parsed.paths.slice(0, 8)) lines.push('  ' + entry)
          if (parsed.paths.length > 8) lines.push('  ... and ' + (parsed.paths.length - 8) + ' more')
        }
        lines.push('')
        lines.push('Next: `hf_repo` confirms the local revision and weight files; `hf_cache` action "verify" checksums the bytes.')
        return {
          text: lines.join('\n'),
          view: { ok: true, repo: info.repo, type: info.type, plan, addedBytes: Math.max(0, added), elapsedMs: answer.elapsedMs, paths: parsed.paths, answerShape: parsed.shape, before, after },
        }
      } catch (error) {
        return failureOf(error)
      }
    },
  }

  return [status, search, repo, cache, download]
}

/** Parameter counts as a reader sizes them: 8.8B, 418M. */
export function formatParamCount(value) {
  if (!Number.isFinite(value) || value <= 0) return 'n/a'
  if (value >= 1e12) return (value / 1e12).toFixed(1) + 'T'
  if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B'
  if (value >= 1e6) return (value / 1e6).toFixed(0) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(0) + 'K'
  return String(value)
}

/** Exported for the package check. */
export const __tools = { formatBytes, formatCount, formatParamCount, table, localVerdict, localState }
