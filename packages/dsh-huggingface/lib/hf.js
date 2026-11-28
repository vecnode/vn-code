/**
 * dsh-huggingface — argv builders and the JSON reader.
 *
 * The CLI is the user's own program and its `--format json` is the contract this
 * row reads; nothing here talks HTTP. That keeps the "no network egress a plugin
 * starts on its own" rule intact: a call is made because a tool was asked for,
 * the CLI carries the credentials, and this package ships no client.
 *
 * THE SHAPES THIS ROW HAD TO MEASURE, because each one is silent when wrong:
 *
 *   - `hf cache ls --json` is REAL JSON but its `size` is a human string
 *     ("17.9G") and its `last_accessed` is relative ("3 months ago"). Byte-exact
 *     numbers therefore come from `cache.js`, never from this JSON.
 *   - `hf cache rm` prompts unless `-y` is given, and stdin is closed here, so a
 *     missing `-y` is a hang. The confirmation is this row's own (`confirm`), and
 *     `-y` is passed only after it.
 *   - an UNCONFIRMED removal is the CLI's own `--dry-run`, so the answer is a
 *     real preview rather than prose about one.
 *   - a removal target is `<type>/<repo>` (the `id` field of `cache ls`), not a
 *     bare repo id.
 */

import { HfError, classifyFailure } from './errors.js'
import { CAPS } from './validate.js'
import { resolveCli } from './cli.js'

/** The properties `hf <group> info --expand` is asked for. */
export const EXPAND_PROPERTIES = [
  'author',
  'cardData',
  'config',
  'createdAt',
  'downloads',
  'downloadsAllTime',
  'gated',
  'gguf',
  'lastModified',
  'library_name',
  'likes',
  'pipeline_tag',
  'private',
  'safetensors',
  'sha',
  'siblings',
  'tags',
  'trendingScore',
  'usedStorage',
].join(',')

/** The flags that turn any subcommand's output into JSON. */
export const JSON_FLAGS = ['--format', 'json']

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
/** `hf <group> list` for a search. */
export function buildSearchArgv(bin, spec) {
  const argv = [bin, spec.group, 'list', '--limit', String(spec.limit)]
  if (spec.query !== '') argv.push('--search', spec.query)
  if (spec.author !== '') argv.push('--author', spec.author)
  for (const filter of spec.filters) argv.push('--filter', filter)
  if (spec.sort !== '') argv.push('--sort', spec.sort)
  argv.push(...JSON_FLAGS)
  return argv
}

/** `hf <group> info <repo> --expand ...`. */
export function buildInfoArgv(bin, spec) {
  return [bin, spec.group, 'info', spec.repo, '--expand', EXPAND_PROPERTIES, ...JSON_FLAGS]
}

/** `hf cache ...` for one action; a removal without confirmation is a dry run. */
export function buildCacheArgv(bin, spec) {
  if (spec.action === 'list') return [bin, 'cache', 'ls', ...JSON_FLAGS]
  if (spec.action === 'verify') {
    const argv = [bin, 'cache', 'verify', spec.repo, '--type', spec.type]
    if (spec.revision !== '') argv.push('--revision', spec.revision)
    argv.push(...JSON_FLAGS)
    return argv
  }
  const confirmed = spec.confirm === (spec.action === 'prune' ? 'prune' : spec.repo)
  if (spec.action === 'prune') {
    return [bin, 'cache', 'prune', ...(confirmed ? ['--yes'] : ['--dry-run']), ...JSON_FLAGS]
  }
  return [bin, 'cache', 'rm', spec.type + '/' + spec.repo, ...(confirmed ? ['--yes'] : ['--dry-run']), ...JSON_FLAGS]
}

/** `hf download <repo> [files] --include ...`. */
export function buildDownloadArgv(bin, spec) {
  const argv = [bin, 'download', spec.repo]
  for (const file of spec.files) argv.push(file)
  argv.push('--type', spec.type)
  if (spec.revision !== '') argv.push('--revision', spec.revision)
  for (const pattern of spec.include) argv.push('--include', pattern)
  for (const pattern of spec.exclude) argv.push('--exclude', pattern)
  argv.push('--max-workers', '8', ...JSON_FLAGS)
  return argv
}

// ---------------------------------------------------------------------------
// the one call
// ---------------------------------------------------------------------------
/**
 * Run one `hf` argv and read its stdout as JSON.
 *
 * @param deps - `{ env, runner, cache, log }`.
 * @param argv - the complete argv, `bin` included.
 * @param options - `{ timeoutMs, maxBytes, allowLoose }`.
 * @returns `{ data, argv, status, elapsedMs, stdout, stderr, cli }`; `data` is
 *   the parsed JSON, or - with `allowLoose` - `{ lines }` of non-empty stdout.
 */
export async function callCli(deps, argv, options = {}) {
  const cli = await resolveCli(deps)
  if (cli.bin === null) {
    throw new HfError('NO_CLI', 'No `hf` on this PATH, and none named by DSH_HF_CLI. ' + HfError.CODES.NO_CLI + '. The cache scan still works without it: `hf_status` / `hf_cache` action "list" read the directory tree.')
  }
  const started = typeof deps.now === 'function' ? deps.now() : Date.now()
  const result = await deps.runner(argv, {
    timeoutMs: options.timeoutMs ?? CAPS.readTimeoutMs,
    maxBytes: options.maxBytes ?? CAPS.maxOutputBytes,
    env: deps.env,
  })
  const elapsedMs = (typeof deps.now === 'function' ? deps.now() : Date.now()) - started
  const base = { argv, elapsedMs, stdout: '', stderr: '', status: null, cli }
  if (result === null || result === undefined || result.status === null) {
    throw new HfError('NO_CLI', '`' + argv[0] + '` could not be started: ' + (result && result.error ? result.error : 'unknown error') + '.')
  }
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  if (result.timedOut === true) {
    throw new HfError('TIMEOUT', '`hf ' + argv.slice(1, 3).join(' ') + '` exceeded ' + Math.round((options.timeoutMs ?? CAPS.readTimeoutMs) / 1000) + ' s and was killed.')
  }
  let data
  try {
    data = JSON.parse(stdout.trim())
  } catch (error) {
    if (result.status !== 0) {
      const code = classifyFailure(stderr + '\n' + stdout, result.status)
      throw new HfError(code, (HfError.CODES[code] ?? 'the command failed') + '\n\n' + tail(stderr || stdout))
    }
    if (options.allowLoose === true) {
      return { ...base, data: { lines: stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') }, status: result.status, stdout, stderr }
    }
    throw new HfError('OUTPUT', '`hf ' + argv.slice(1, 3).join(' ') + '` exited 0 but did not answer JSON, so this row cannot read it. That is a version mismatch: run `hf --version` and compare it with the version this row was checked against.\n\n' + tail(stdout || stderr))
  }
  return { ...base, data, status: result.status, stdout, stderr }
}

/** The last few lines of a stream, for an error message. */
function tail(text, lines = 6) {
  const all = String(text ?? '').trim().split(/\r?\n/)
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/** Run one argv through `callCli` after resolving the binary. */
export async function runHf(deps, build, spec, options = {}) {
  const cli = await resolveCli(deps)
  if (cli.bin === null) {
    throw new HfError('NO_CLI', 'No `hf` on this PATH, and none named by DSH_HF_CLI. ' + HfError.CODES.NO_CLI)
  }
  return callCli(deps, build(cli.bin, spec), options)
}

// ---------------------------------------------------------------------------
// reading a repo's info
// ---------------------------------------------------------------------------
/** A finite number or null. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A trimmed string or ''. */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Normalise `hf <group> info` into the facts this row reports.
 *
 * @param data - the parsed JSON.
 * @param spec - `{ repo, type, group }`.
 * @returns the normalised record.
 */
export function normalizeInfo(data, spec) {
  const body = data !== null && typeof data === 'object' ? data : {}
  const card = body.cardData !== null && typeof body.cardData === 'object' ? body.cardData : {}
  const siblings = Array.isArray(body.siblings) ? body.siblings : []
  const files = siblings
    .map((entry) => {
      const name = str(entry?.rfilename) || str(entry?.path)
      const size = finite(entry?.size) ?? finite(entry?.lfs?.size)
      return name === '' ? null : { name, bytes: size, lfs: entry?.lfs !== undefined && entry?.lfs !== null }
    })
    .filter((entry) => entry !== null)
  const sized = files.filter((entry) => entry.bytes !== null)
  const siblingTotal = sized.reduce((sum, entry) => sum + entry.bytes, 0)
  // MEASURED: `hf models info` on this line has NO --blobs flag, so `siblings`
  // never carries per-file sizes - only `used_storage` (bytes) is available for
  // the repo. A size is therefore reported with its SOURCE, never as if the file
  // list had been summed when it was not.
  const usedStorage = finite(body.used_storage) ?? finite(body.usedStorage)
  const totalBytes = usedStorage !== null ? usedStorage : siblingTotal
  const totalSource = usedStorage !== null ? 'hub storage' : sized.length > 0 ? 'file sizes' : 'none'
  const perFileSizes = files.length > 0 && sized.length === files.length
  const rawLicence = card.license
  const licence = Array.isArray(rawLicence) ? rawLicence.map((value) => str(value)).filter(Boolean).join(', ') : str(rawLicence)
  const licenceFromTag = (Array.isArray(body.tags) ? body.tags : []).map(str).find((tag) => tag.startsWith('license:'))
  const gated = body.gated === true || body.gated === 'auto' || body.gated === 'manual' ? String(body.gated) : ''
  const config = body.config !== null && typeof body.config === 'object' ? body.config : {}
  const safetensors = body.safetensors !== null && typeof body.safetensors === 'object' ? body.safetensors : {}
  const gguf = body.gguf !== null && typeof body.gguf === 'object' ? body.gguf : {}
  const params = finite(safetensors.total) ?? finite(gguf.total)
  return {
    repo: str(body.id) || spec.repo,
    type: spec.type,
    sha: str(body.sha),
    private: body.private === true,
    gated,
    licence: licence !== '' ? licence : licenceFromTag !== undefined ? licenceFromTag.slice('license:'.length) : '',
    pipelineTag: str(body.pipeline_tag),
    library: str(body.library_name),
    downloads: finite(body.downloads),
    likes: finite(body.likes),
    createdAt: str(body.createdAt),
    lastModified: str(body.lastModified),
    tags: (Array.isArray(body.tags) ? body.tags : []).map(str).filter(Boolean),
    files,
    totalBytes,
    totalSource,
    perFileSizes,
    sizesComplete: perFileSizes,
    unknownSizes: files.length - sized.length,
    params,
    architectures: (Array.isArray(config.architectures) ? config.architectures : []).map(str).filter(Boolean),
    modelType: str(config.model_type),
    contextLength: finite(config.max_position_embeddings) ?? finite(config.n_positions) ?? finite(config.text_config?.max_position_embeddings),
    quant: str(gguf.architecture) !== '' ? str(gguf.architecture) : '',
  }
}

/**
 * Which consumer would fetch which files - the question a 17 GB repo hides.
 *
 * @param files - `[{ name, bytes }]`.
 * @returns `[{ consumer, files, note }]`, only for consumers that match.
 */
export function consumersOf(files) {
  const names = files.map((file) => file.name)
  const pick = (predicate) => files.filter((file) => predicate(file.name)).map((file) => file.name)
  const out = []
  const transformers = pick((name) => /(^|\/)(config\.json|tokenizer(\.json|_config\.json)?|special_tokens_map\.json|vocab\.json|vocab\.txt|merges\.txt|generation_config\.json|model\.safetensors|pytorch_model.*\.bin)$/.test(name))
  if (transformers.length > 0) {
    out.push({ consumer: 'transformers', files: transformers, note: 'config + tokenizer + one weight format: fetch these, not the whole repo' })
  }
  const sentence = pick((name) => /(^|\/)(modules\.json|config_sentence_transformers\.json|sentence_bert_config\.json)$/.test(name))
  if (sentence.length > 0) out.push({ consumer: 'sentence-transformers', files: sentence, note: 'embeddings through sentence-transformers' })
  const diffusers = pick((name) => /(^|\/)model_index\.json$/.test(name))
  if (diffusers.length > 0) out.push({ consumer: 'diffusers', files: diffusers, note: 'a diffusion pipeline: dsh-comfyui owns running one' })
  const gguf = names.filter((name) => /\.gguf$/i.test(name))
  if (gguf.length > 0) out.push({ consumer: 'llama.cpp / Ollama', files: gguf, note: 'pick ONE quant, not every quant in the repo' })
  const onnx = names.filter((name) => /\.onnx$/i.test(name))
  if (onnx.length > 0) out.push({ consumer: 'onnxruntime', files: onnx, note: 'an ONNX export is not a transformers checkpoint' })
  return out
}

// ---------------------------------------------------------------------------
// patterns and projection
// ---------------------------------------------------------------------------
/**
 * Compile a Hub glob (`*`, `**`, `?`) into a regular expression.
 *
 * `*` stays inside one path segment; `**` crosses them. That difference is the
 * one that decides whether `--include *.safetensors` reaches a sharded subfolder.
 */
export function globToRegExp(pattern) {
  let out = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/**
 * Whether a file passes the include/exclude patterns.
 *
 * An empty include list means "everything"; an exclude always wins.
 */
export function selected(name, include, exclude) {
  const included = include.length === 0 || include.some((pattern) => globToRegExp(pattern).test(name))
  if (!included) return false
  return !exclude.some((pattern) => globToRegExp(pattern).test(name))
}

/**
 * What a download would fetch, from the repo's own file list.
 *
 * The answer names WHICH measure it used, because this CLI line gives no
 * per-file sizes: a selection that covers the whole repo is measured by the
 * Hub's `used_storage`, and a narrower one can only be measured when the file
 * list carried sizes. Reporting a made-up number for a partial selection would
 * be worse than reporting none.
 *
 * @returns `{ files, bytes, known, unknown, complete, measured, coversAll }`
 *   where `bytes` is null when nothing measured it and `measured` is
 *   'repo' | 'files' | 'unknown'.
 */
export function projectDownload(info, spec) {
  const coversAll = spec.files.length === 0 && spec.include.length === 0 && spec.exclude.length === 0
  const wanted = info.files.filter((file) => {
    if (spec.files.length > 0 && !spec.files.includes(file.name)) return false
    return selected(file.name, spec.include, spec.exclude)
  })
  const known = wanted.filter((file) => file.bytes !== null)
  const sum = known.reduce((total, file) => total + file.bytes, 0)
  let bytes = null
  let measured = 'unknown'
  if (wanted.length > 0 && known.length === wanted.length) {
    bytes = sum
    measured = 'files'
  } else if (coversAll && info.totalSource === 'hub storage' && info.totalBytes > 0) {
    // The whole repo, which is exactly what `used_storage` describes - and the
    // selection IS everything, so the figure applies to it.
    bytes = info.totalBytes
    measured = 'repo'
  } else if (coversAll && known.length > 0) {
    // Every file was selected but some sizes are missing: this is a floor, not
    // a total, and it is labelled as one.
    bytes = sum
    measured = 'lower-bound'
  }
  return {
    files: wanted.map((file) => file.name),
    bytes,
    known: known.length,
    unknown: wanted.length - known.length,
    complete: measured === 'files' || measured === 'repo',
    measured,
    coversAll,
  }
}

/**
 * Read a `hf download` answer into file paths.
 *
 * The CLI's own answer has been a JSON array of paths in the versions seen so
 * far, but a `{"downloaded": [...]}` object and a plain line-per-path are both
 * plausible, so all three are accepted rather than assumed.
 */
export function parseDownloadAnswer(data) {
  if (Array.isArray(data)) return { paths: data.filter((entry) => typeof entry === 'string'), shape: 'array' }
  if (data !== null && typeof data === 'object') {
    for (const key of ['downloaded', 'paths', 'files']) {
      if (Array.isArray(data[key])) return { paths: data[key].filter((entry) => typeof entry === 'string'), shape: 'object.' + key }
    }
    if (Array.isArray(data.lines)) return { paths: data.lines.filter((line) => line !== '' && !line.startsWith('{')), shape: 'lines' }
  }
  return { paths: [], shape: 'unknown' }
}
