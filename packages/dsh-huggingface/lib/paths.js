/**
 * dsh-huggingface — where the cache is, in the order huggingface_hub resolves it.
 *
 * The precedence is the library's own (`huggingface_hub.constants`), because a
 * reader who moved their cache with one variable must not be told about a
 * different directory by this row:
 *
 *   HF_HUB_CACHE > HUGGINGFACE_HUB_CACHE > HF_HOME/hub > ~/.cache/huggingface/hub
 *
 * The deprecated `TRANSFORMERS_CACHE` is read LAST and reported as deprecated
 * rather than as a supported location: it still moves the cache for some
 * library versions, so silently ignoring it would make this row describe the
 * wrong directory on a machine that set it.
 *
 * Nothing here writes, probes or creates a directory.
 */

import os from 'node:os'
import path from 'node:path'

/** The variable names, in resolution order, each with what it means. */
export const CACHE_ENV_ORDER = [
  { key: 'HF_HUB_CACHE', kind: 'root' },
  { key: 'HUGGINGFACE_HUB_CACHE', kind: 'root' },
  { key: 'HF_HOME', kind: 'home' },
  { key: 'TRANSFORMERS_CACHE', kind: 'root', deprecated: true },
]

/** True when a variable holds a usable path. */
function usable(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Resolve the cache root and say which variable chose it.
 *
 * @param env - the environment (`process.env` by default).
 * @param homedir - the home directory (`os.homedir()` by default).
 * @returns `{ root, from, deprecated, candidates }` where `candidates` is every
 *   directory that COULD hold a cache, so a caller can report the ones that
 *   exist without claiming the others are empty.
 */
export function resolveCacheRoot(env = process.env, homedir = os.homedir()) {
  if (usable(env.HF_HUB_CACHE)) return { root: path.resolve(env.HF_HUB_CACHE.trim()), from: 'HF_HUB_CACHE', deprecated: false }
  if (usable(env.HUGGINGFACE_HUB_CACHE)) return { root: path.resolve(env.HUGGINGFACE_HUB_CACHE.trim()), from: 'HUGGINGFACE_HUB_CACHE', deprecated: false }
  if (usable(env.HF_HOME)) return { root: path.join(path.resolve(env.HF_HOME.trim()), 'hub'), from: 'HF_HOME', deprecated: false }
  for (const entry of CACHE_ENV_ORDER) {
    if (entry.deprecated === true && usable(env[entry.key])) {
      return { root: path.resolve(env[entry.key].trim()), from: entry.key, deprecated: true }
    }
  }
  return { root: path.join(homedir, '.cache', 'huggingface', 'hub'), from: 'default', deprecated: false }
}

/**
 * Whether the libraries are told to stay off the network.
 *
 * Both variables are read: `HF_HUB_OFFLINE` governs the Hub client and
 * `TRANSFORMERS_OFFLINE` is what transformers users set, and a machine with
 * either set must not be sent to the network by this row.
 */
export function offlineOf(env = process.env) {
  const value = String(env.HF_HUB_OFFLINE ?? env.TRANSFORMERS_OFFLINE ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Whether a token is configured - the PRESENCE only, never the value.
 *
 * `HF_TOKEN` wins over the stored file, because that is the order the library
 * reads them in. The caller reports "a token is set (HF_TOKEN)" and never the
 * secret; nothing in this row reads the file's contents.
 *
 * @param env - the environment.
 * @param tokenFileExists - whether `~/.cache/huggingface/token` exists.
 */
export function tokenPresence(env = process.env, tokenFileExists = false) {
  if (usable(env.HF_TOKEN)) return { present: true, source: 'HF_TOKEN' }
  if (usable(env.HUGGING_FACE_HUB_TOKEN)) return { present: true, source: 'HUGGING_FACE_HUB_TOKEN' }
  if (tokenFileExists) return { present: true, source: 'stored token file' }
  return { present: false, source: '' }
}
