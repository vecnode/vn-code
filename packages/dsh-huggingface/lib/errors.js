/**
 * dsh-huggingface — the one error type, so every refusal carries a code.
 *
 * A refusal is an answer. Each code below is a thing the caller can branch on
 * and a thing the prose must name the fix for: a missing CLI says where the CLI
 * comes from, a gated repo names the licence page, a repo over the byte ceiling
 * says its size and the ceiling it was measured against.
 */

export class HfError extends Error {
  /**
   * @param code - one of the codes in `HfError.CODES`.
   * @param message - the sentence a reader acts on.
   * @param details - extra facts for the view (sizes, names, versions).
   */
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'HfError'
    this.code = code
    this.details = details ?? {}
  }
}

/** Every code this row can answer with. */
HfError.CODES = {
  NO_CLI: 'no `hf` CLI on this PATH - `pip install -U huggingface_hub` provides it (huggingface-cli is the old name)',
  BAD_INPUT: 'bad input',
  OFFLINE: 'this machine is in offline mode (HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1)',
  NOT_FOUND: 'the Hub does not have that repo (or that revision)',
  GATED: 'the repo is gated: its licence must be accepted by a person in a browser first',
  AUTH: 'the Hub refused the credentials (401) - `hf auth login`',
  FORBIDDEN: 'the Hub refused access (403) - a token is required, or it lacks the scope',
  RATE_LIMIT: 'the Hub is rate-limiting (429) - wait, or use a token',
  NETWORK: 'no answer from huggingface.co',
  DISK_FULL: 'no space left on the disk that holds the cache',
  TIMEOUT: 'the command exceeded its deadline',
  OUTPUT: 'the CLI answered something this row could not read as JSON',
  NOT_CONFIRMED: 'the write was not confirmed',
  TOO_BIG: 'the download is larger than the byte ceiling',
  UNSUPPORTED: 'not supported here',
}

/** The message of any thrown value. */
export function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * Map the CLI's stderr onto a code.
 *
 * `hf` writes one short reason per line and exits non-zero; the exit code alone
 * cannot tell a gated repo from a missing one, so the text is what is read. The
 * order matters: "access to model ... is restricted" must win over a generic
 * 403, and "Repository Not Found" must win over a generic 404.
 *
 * @param text - stderr (and stdout, which sometimes carries the message).
 * @param status - the exit code, for the cases the text does not name.
 */
export function classifyFailure(text, status) {
  const body = String(text ?? '')
  if (/gated|access to model .*restricted|awaiting a review|you need to agree|accept the terms/i.test(body)) return 'GATED'
  if (/Repository Not Found|404 Client Error|Entry not found/i.test(body)) return 'NOT_FOUND'
  if (/Invalid credentials|authentication|token is invalid|401 Client Error|must be authenticated/i.test(body)) return 'AUTH'
  if (/403 Client Error|Forbidden|cannot access/i.test(body)) return 'FORBIDDEN'
  if (/429|rate limit/i.test(body)) return 'RATE_LIMIT'
  if (/No space left|ENOSPC|not enough space/i.test(body)) return 'DISK_FULL'
  if (/Connection|getaddrinfo|Name or service not known|timed out|Max retries|Network is unreachable/i.test(body)) return 'NETWORK'
  if (status === 401) return 'AUTH'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  return 'OUTPUT'
}
