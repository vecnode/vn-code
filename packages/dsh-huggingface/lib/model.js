/**
 * dsh-huggingface — what a cached checkpoint will cost to LOAD, from its files.
 *
 * This is the half of a model-runner row that belongs to a Hub row: the question
 * "should I download this?" does not end at the download size, it ends at "can
 * this machine run it". Both halves are answered from the same bytes on disk, so
 * no Python, no torch and no model load are involved.
 *
 * The arithmetic, and the reason each term is here:
 *
 *   weights   = the sum of the checkpoint's weight files (a safetensors file is
 *               stored at its save dtype, so its size IS its weight bytes)
 *   params    = weights / bytes-per-parameter at that dtype (an ESTIMATE, and
 *               labelled as one: a sharded index would give the exact count)
 *   KV        = 2 x layers x kv_heads x head_dim x dtype_bytes, PER TOKEN
 *   overhead  = max(512 MiB, 10% of the weights) for activations, the allocator
 *               and workspaces
 *
 * The KV term is the one people get wrong, and the reason this file exists: on
 * the machine that wrote this, a 32-layer model with 8 KV heads at head_dim 128
 * needs 128 KiB PER TOKEN, so 32k context is 4 GiB on top of the weights while
 * 4k is 512 MiB. A model that "fits" at 4k and OOMs at 32k is behaving exactly
 * as described here.
 *
 * Grouped-query attention is what makes the number smaller than a naive
 * `2 x layers x heads x head_dim` would suggest, and a config that does not
 * state its heads is reported as UNKNOWN rather than assumed.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** The extensions a checkpoint keeps its weights in. */
export const WEIGHT_FILES = /\.(safetensors|bin|pt|pth|ckpt)$/i

/** Bytes per parameter, by dtype name. */
export const DTYPE_BYTES = { float32: 4, fp32: 4, float16: 2, fp16: 2, bfloat16: 2, bf16: 2, int8: 1, int4: 0.5 }

/** The safetensors dtype codes, mapped to the names a reader knows. */
export const SAFETENSORS_DTYPE = { F32: 'float32', F16: 'float16', BF16: 'bfloat16', F8_E4M3: 'float8', F8_E5M2: 'float8', I64: 'int64', I32: 'int32', I16: 'int16', I8: 'int8', U8: 'uint8', BOOL: 'bool' }

/**
 * The dtype a `.safetensors` file ACTUALLY holds, from its header.
 *
 * The parameter estimate and the KV-cache size both divide or multiply by the
 * bytes-per-parameter, so assuming fp16 because the config SAYS fp16 is how a
 * 109M-parameter model is reported as 219M. MEASURED: on the machine that wrote
 * this, `sentence-transformers/all-mpnet-base-v2` has no `torch_dtype` in its
 * config and its weights are F32 - so the bytes divided by 2 and the model was
 * called twice its size until the header was read.
 *
 * The header is a little-endian u64 length followed by that many bytes of JSON:
 * a few tens of KB read from the FRONT of the file, never the tensors.
 *
 * @param file - a `.safetensors` path.
 * @returns the dtype name, or '' when the header cannot be read.
 */
export function safetensorsDtype(file) {
  let handle = null
  try {
    handle = openSync(file, 'r')
    const lengthBytes = Buffer.alloc(8)
    if (readSync(handle, lengthBytes, 0, 8, 0) !== 8) return ''
    const length = Number(lengthBytes.readBigUInt64LE(0))
    if (!Number.isFinite(length) || length <= 0 || length > 100 * 1024 * 1024) return ''
    const header = Buffer.alloc(length)
    if (readSync(handle, header, 0, length, 8) !== length) return ''
    const parsed = JSON.parse(header.toString('utf8'))
    const counts = new Map()
    for (const [key, value] of Object.entries(parsed)) {
      if (key === '__metadata__' || value === null || typeof value !== 'object') continue
      const dtype = typeof value.dtype === 'string' ? value.dtype : ''
      if (dtype === '') continue
      counts.set(dtype, (counts.get(dtype) ?? 0) + 1)
    }
    let best = ''
    let bestCount = 0
    for (const [dtype, count] of counts) {
      if (count > bestCount) {
        best = dtype
        bestCount = count
      }
    }
    return SAFETENSORS_DTYPE[best] ?? ''
  } catch (error) {
    return ''
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch (error) {
        /* already closed */
      }
    }
  }
}

/** A number, or null. */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The language-model view of a config, including the multimodal nesting.
 *
 * A vision-language checkpoint keeps its text model under `text_config`, so
 * reading only the top level finds no layers and reports the KV cache as
 * unknown - which would be honest but useless.
 */
export function modelFields(config) {
  const base = config !== null && typeof config === 'object' ? config : {}
  const inner = base.text_config !== null && typeof base.text_config === 'object' ? base.text_config : base
  const layers = number(inner.num_hidden_layers) ?? number(inner.n_layer) ?? number(inner.num_layers)
  const heads = number(inner.num_attention_heads) ?? number(inner.n_head)
  const kvHeads = number(inner.num_key_value_heads) ?? number(inner.multi_query_group_num) ?? heads
  const hidden = number(inner.hidden_size) ?? number(inner.n_embd) ?? number(inner.d_model)
  const headDim = number(inner.head_dim) ?? (hidden !== null && heads !== null && heads > 0 ? Math.round(hidden / heads) : null)
  return {
    architectures: Array.isArray(base.architectures) ? base.architectures.filter((entry) => typeof entry === 'string') : [],
    modelType: typeof base.model_type === 'string' ? base.model_type : '',
    layers,
    heads,
    kvHeads,
    headDim,
    hiddenSize: hidden,
    contextLength: number(inner.max_position_embeddings) ?? number(inner.n_positions) ?? number(inner.seq_length) ?? number(inner.model_max_length),
    vocabSize: number(inner.vocab_size),
    torchDtype: typeof base.torch_dtype === 'string' ? base.torch_dtype : typeof base.dtype === 'string' ? base.dtype : '',
    quantization: base.quantization_config !== null && typeof base.quantization_config === 'object' ? base.quantization_config : null,
  }
}

/**
 * Read a checkpoint folder: its config and its weight bytes.
 *
 * @param dir - the directory holding `config.json` and the weights.
 * @returns `{ config, weights, weightsBytes, hasWeights, warnings }`.
 */
export function readCheckpoint(dir) {
  const warnings = []
  let config = null
  if (existsSync(path.join(dir, 'config.json'))) {
    try {
      const raw = readFileSync(path.join(dir, 'config.json'), 'utf8')
      config = JSON.parse(raw.slice(0, 2_000_000))
    } catch (error) {
      warnings.push('config.json could not be read as JSON: ' + (error && error.message ? error.message : String(error)))
    }
  } else {
    warnings.push('no config.json in this snapshot')
  }
  const weights = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isFile() || !WEIGHT_FILES.test(entry.name)) continue
    try {
      weights.push({ name: entry.name, bytes: statSync(path.join(dir, entry.name)).size })
    } catch (error) {
      /* a file removed mid-read is not a checkpoint we can size */
    }
  }
  const weightsBytes = weights.reduce((sum, file) => sum + file.bytes, 0)
  // The dtype is read from a safetensors HEADER when there is one, because the
  // config's claim and the file's contents disagree often enough to matter.
  const safetensors = weights.find((file) => /\.safetensors$/i.test(file.name))
  const fileDtype = safetensors === undefined ? '' : safetensorsDtype(path.join(dir, safetensors.name))
  if (fileDtype !== '' && config !== null && typeof config.torch_dtype === 'string') {
    const claimed = String(config.torch_dtype).toLowerCase()
    if (/float32|fp32/.test(claimed) === false && /float32/.test(fileDtype)) {
      warnings.push('config.json claims ' + config.torch_dtype + ' but the weights are ' + fileDtype + '; the header wins')
    }
  }
  return { config, weights, weightsBytes, hasWeights: weights.length > 0, fileDtype, warnings }
}

/**
 * Size a checkpoint for a set of contexts.
 *
 * @param options - `{ weightsBytes, fields, dtype, contexts }`.
 * @returns `{ params, dtype, bytesPerParam, kvPerToken, kvKnown, overhead, vram }`
 *   where each `vram` row is `{ context, weights, kv, total }`.
 */
export function estimateVram(options = {}) {
  const weightsBytes = Number.isFinite(options.weightsBytes) ? options.weightsBytes : 0
  const fields = options.fields ?? {}
  const dtype = String(options.dtype ?? fields.torchDtype ?? 'float16').toLowerCase()
  const bytesPerParam = DTYPE_BYTES[dtype] ?? 2
  const params = weightsBytes > 0 && bytesPerParam > 0 ? Math.round(weightsBytes / bytesPerParam) : null

  const layers = fields.layers ?? 0
  const kvHeads = fields.kvHeads ?? 0
  const headDim = fields.headDim ?? 0
  // The cache is written at the model's own dtype; fp32 weights keep an fp32
  // cache, everything smaller is stored at 2 bytes.
  const kvBytes = bytesPerParam >= 4 ? 4 : 2
  const kvPerToken = 2 * layers * kvHeads * headDim * kvBytes
  const overhead = Math.max(512 * 1024 * 1024, Math.round(weightsBytes * 0.1))

  const wanted = Array.isArray(options.contexts) && options.contexts.length > 0 ? options.contexts : [4096, 8192, 32768]
  const vram = wanted
    .filter((context) => Number.isFinite(context) && context > 0)
    .slice(0, 6)
    .map((context) => ({
      context,
      weights: weightsBytes,
      kv: kvPerToken * context,
      total: weightsBytes + kvPerToken * context + overhead,
    }))
  return { params, dtype, bytesPerParam, kvPerToken, kvKnown: kvPerToken > 0, overhead, vram }
}
