/**
 * dsh-research — the review.
 *
 * A review is a ledger of CONCERNS and what happened to each one: who raised it,
 * how serious it is, what in the manuscript grounds it, what the author did about
 * it, and whether a re-review confirmed the fix. That is the traceability matrix a
 * response-to-reviewers letter is supposed to be, and it is the one document a
 * submitter cannot write from memory months later.
 *
 * Two things here are mechanisms rather than advice, because they are the two
 * places a model reliably fails in a way that looks like success:
 *
 *   1. **The concession threshold.** A devil's advocate that concedes whenever it
 *      is pushed is worse than no devil's advocate: it produces the APPEARANCE of
 *      adversarial review. So a concession is refused unless the rebuttal it is
 *      conceding to is scored at or above the threshold, the score is recorded with
 *      it, and **two concessions in a row are refused outright** - the sycophancy
 *      pattern this protocol exists to slow. ARS asks for that discipline in prose;
 *      a ledger can enforce it.
 *   2. **A concern is not addressed until something says so.** `rejected` and
 *      `addressed` are the AUTHOR's claims; `verified` is a re-review's finding, and
 *      the matrix keeps them in separate columns because "I fixed it" and "it is
 *      fixed" are different statements. A letter that merges them is how a revision
 *      passes review without the change existing.
 */

import { ResearchError, stamp } from './run.js'
import { appendJsonl, foldLatest, ledgerPath, readJsonl } from './ledger.js'

/** Who can raise a concern. The roles are the panel a review is made of. */
export const REVIEW_ROLES = ['journal-fit', 'methodology', 'domain', 'devils-advocate', 'editor', 'author']
/** What a concern is ABOUT. Closed, so a report can group by criterion. */
export const REVIEW_CRITERIA = ['fit', 'method', 'evidence', 'novelty', 'clarity', 'ethics', 'reproducibility', 'significance']
/** How serious it is. */
export const REVIEW_SEVERITIES = ['major', 'minor', 'note']
/** What happened to it. */
export const REVIEW_STATUSES = ['open', 'addressed', 'rejected']
/**
 * The score a rebuttal must earn before the devil's advocate may concede.
 *
 * 1 is "you repeated yourself"; 3 is a real answer to a different question; 4 is a
 * direct answer to the attack WITH evidence; 5 is that plus a demonstration. Only 4
 * and 5 are allowed to change the advocate's position. The number is here rather
 * than in a skill because the tool refuses on it.
 */
export const CONCESSION_THRESHOLD = 4
export const CONCESSION_MAX = 5
/** Above this share of concessions, the report says the pattern out loud. */
export const SYCOPHANCY_RATE = 0.5
/** How many attacks the rate needs before it means anything. */
export const SYCOPHANCY_FLOOR = 4

/** One concern, validated. */
export function normalizeFinding(input, now) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ResearchError('BAD_FINDING', 'a finding is an object: { role, concern, severity?, criterion?, evidence?, suggestion? }')
  }
  const role = String(input.role ?? '').trim()
  if (!REVIEW_ROLES.includes(role)) {
    throw new ResearchError('BAD_ROLE', 'role must be one of ' + REVIEW_ROLES.join(', ') + ' (got ' + JSON.stringify(role) + ')')
  }
  const concern = String(input.concern ?? '').trim()
  if (concern === '') {
    throw new ResearchError('BAD_FINDING', 'a finding needs a `concern` - the sentence the author has to answer')
  }
  const severity = input.severity === undefined || input.severity === '' ? 'major' : String(input.severity)
  if (!REVIEW_SEVERITIES.includes(severity)) {
    throw new ResearchError('BAD_SEVERITY', 'severity must be one of ' + REVIEW_SEVERITIES.join(', ') + ' (got ' + JSON.stringify(severity) + ')')
  }
  const criterion = input.criterion === undefined || input.criterion === '' ? 'evidence' : String(input.criterion)
  if (!REVIEW_CRITERIA.includes(criterion)) {
    throw new ResearchError('BAD_CRITERION', 'criterion must be one of ' + REVIEW_CRITERIA.join(', ') + ' (got ' + JSON.stringify(criterion) + ')')
  }
  const text = (value, max) => String(value ?? '').trim().slice(0, max)
  return {
    role,
    concern: text(concern, 2000),
    severity,
    criterion,
    // What in the MANUSCRIPT grounds the concern: a section slug, a claim id, a
    // page. A concern with no location is one the author cannot find, which is the
    // commonest way a review wastes a revision round.
    evidence: text(input.evidence, 500),
    suggestion: text(input.suggestion, 1000),
    status: 'open',
    reply: '',
    verifiedBy: '',
    verified: null,
    createdAt: stamp(now),
  }
}

/** Every review revision and the current row per id. */
export async function readReviewRows(runDir) {
  const file = ledgerPath(runDir, 'reviews')
  const rows = await readJsonl(file)
  return { file, rows, current: foldLatest(rows, 'id') }
}

/** The next finding id for a run. */
export function nextFindingId(rows) {
  let highest = 0
  for (const row of rows ?? []) {
    const id = row === null || row === undefined ? '' : String(row.id ?? '')
    if (!/^f[0-9]{4,}$/.test(id)) continue
    const value = Number(id.slice(1))
    if (Number.isFinite(value) && value > highest) highest = value
  }
  return 'f' + String(highest + 1).padStart(4, '0')
}

/**
 * Record one round's findings.
 *
 * @param input - `{ round?, items: [{ role, concern, severity?, criterion?, evidence?, suggestion? }] }`.
 * @returns `{ added: [{ id, role, severity }], round }`.
 */
export async function recordFindings(runDir, input, now) {
  const { file, rows } = await readReviewRows(runDir)
  const round = Number.isFinite(Number(input.round)) && Number(input.round) > 0 ? Number(input.round) : nextRound(rows)
  const added = []
  for (const entry of Array.isArray(input.items) ? input.items : []) {
    const id = nextFindingId([...rows, ...added.map((one) => ({ id: one.id }))])
    const row = { id, round, kind: 'finding', ...normalizeFinding(entry, now) }
    await appendJsonl(file, row)
    added.push({ id, role: row.role, severity: row.severity, criterion: row.criterion })
  }
  return { added, round }
}

/**
 * The next round number, from what the ledger already holds.
 *
 * An EMPTY ledger's first round is 1, not 2: `latestRound` answers 1 for "nothing
 * recorded yet" so that a first attack lands in round 1, and adding to that would
 * number the first panel round 2. Two panels would then disagree about which round
 * they are, which is exactly the kind of quiet bookkeeping error that makes a
 * traceability matrix untrustworthy.
 */
export function nextRound(rows) {
  const list = rows ?? []
  return list.length === 0 ? 1 : latestRound(list) + 1
}

/**
 * The round a NEW entry belongs to unless the caller says otherwise.
 *
 * `panel` opens the NEXT round - a fresh set of findings. An attack or a concession
 * belongs to the round it is arguing IN, so it takes the LATEST one. Getting this
 * wrong is not cosmetic: a concession defaulted to a new round is a concession the
 * advocate's own history does not contain, so the consecutive-concession rule finds
 * nothing to refuse and the protocol quietly stops working. That bug was found by
 * driving the sequence end to end.
 */
export function latestRound(rows) {
  let highest = 0
  for (const row of rows ?? []) {
    const value = Number(row === null || row === undefined ? 0 : row.round)
    if (Number.isFinite(value) && value > highest) highest = value
  }
  return highest === 0 ? 1 : highest
}

/**
 * The author's answer to one concern.
 *
 * `addressed` and `rejected` are the author's WORDS about their own work. Neither
 * is a verification: that is what `rereview` records, in its own column.
 */
export async function answerFinding(runDir, input, now) {
  const { file, current } = await readReviewRows(runDir)
  const existing = current.find((row) => row.id === String(input.id ?? '')) ?? null
  if (existing === null) {
    throw new ResearchError('UNKNOWN_FINDING', 'no finding named ' + JSON.stringify(String(input.id ?? '')) + ' - an answer answers something that was raised')
  }
  const status = String(input.status ?? 'addressed')
  if (!['addressed', 'rejected'].includes(status)) {
    throw new ResearchError('BAD_STATUS', 'answering a finding is `addressed` or `rejected` (got ' + JSON.stringify(status) + ')')
  }
  const reply = String(input.reply ?? '').trim()
  if (reply === '') {
    throw new ResearchError('BAD_REPLY', 'an answer needs a `reply`: "addressed" with no sentence is not something a reviewer can check')
  }
  const next = { ...existing, status, reply: reply.slice(0, 2000), answeredAt: stamp(now), revision: Number(existing.revision ?? 1) + 1 }
  await appendJsonl(file, next)
  return next
}

/**
 * A devil's-advocate concession - and the two rules that refuse one.
 *
 * `score` is the advocate's own judgement of the rebuttal it is answering, so it is
 * required: a concession with no score is a concession nobody can review.
 *
 * @returns `{ row, rate }`.
 */
export async function concede(runDir, input, now) {
  const { file, rows, current } = await readReviewRows(runDir)
  const score = Number(input.score)
  if (!Number.isFinite(score) || score < 1 || score > CONCESSION_MAX) {
    throw new ResearchError('BAD_SCORE', 'a rebuttal score is 1-' + CONCESSION_MAX + ' (got ' + JSON.stringify(String(input.score ?? '')) + '): how directly and how evidential the rebuttal was, not how firmly it was made')
  }
  const concern = String(input.concern ?? '').trim()
  if (concern === '') throw new ResearchError('BAD_FINDING', 'a concession states the `concern` it is conceding')
  const reply = String(input.reply ?? '').trim()
  if (reply === '') throw new ResearchError('BAD_REPLY', 'a concession records the `reply` it is conceding to')

  const round = Number.isFinite(Number(input.round)) && Number(input.round) > 0 ? Number(input.round) : latestRound(rows)
  const advocateRows = rows.filter((row) => row !== null && row.role === 'devils-advocate' && Number(row.round) === round)
  const conceding = advocateRows.filter((row) => row.kind === 'concession')
  const attacks = advocateRows.filter((row) => row.kind === 'finding' || row.kind === 'attack')

  // RULE 1: the threshold. Below it the advocate HOLDS POSITION, and the refusal
  // says so - the point is not to record a low score, it is to stop the position
  // changing on one.
  if (score < CONCESSION_THRESHOLD) {
    throw new ResearchError(
      'CONCESSION_BELOW_THRESHOLD',
      'a rebuttal scored ' + score + ' of ' + CONCESSION_MAX + ' does not earn a concession (the threshold is ' + CONCESSION_THRESHOLD + '). HOLD POSITION and restate the attack as it stands - a score of ' +
        score + ' means the reply did not answer it directly with evidence. Record the attempt with `action=attack` if it is worth keeping.',
    )
  }
  // RULE 2: no two in a row. The pattern this catches is a sequence of concessions
  // that looks like a debate and is actually agreement with extra steps.
  const last = advocateRows[advocateRows.length - 1]
  if (last !== undefined && last.kind === 'concession') {
    throw new ResearchError(
      'CONSECUTIVE_CONCESSION',
      'the previous entry for the devil\'s advocate in round ' + round + ' was already a concession. Two in a row is the sycophancy pattern this protocol exists to slow: raise the next attack, or say in a note why there is genuinely nothing left to attack.',
    )
  }

  const row = {
    id: nextFindingId(rows),
    round,
    kind: 'concession',
    role: 'devils-advocate',
    concern: concern.slice(0, 2000),
    severity: 'note',
    criterion: 'evidence',
    evidence: '',
    suggestion: '',
    status: 'addressed',
    reply: reply.slice(0, 2000),
    concessionScore: score,
    verifiedBy: '',
    verified: null,
    createdAt: stamp(now),
  }
  await appendJsonl(file, row)
  const rate = attacks.length + conceding.length + 1 === 0 ? 0 : (conceding.length + 1) / (attacks.length + conceding.length + 1)
  return { row, rate, attacks: attacks.length, concessions: conceding.length + 1 }
}

/** A devil's-advocate ATTACK, so the sequence the rules read actually exists. */
export async function raiseAttack(runDir, input, now) {
  const { file, rows } = await readReviewRows(runDir)
  const round = Number.isFinite(Number(input.round)) && Number(input.round) > 0 ? Number(input.round) : latestRound(rows)
  const row = { id: nextFindingId(rows), round, kind: 'finding', ...normalizeFinding({ ...input, role: 'devils-advocate' }, now) }
  await appendJsonl(file, row)
  return row
}

/**
 * A re-review's verdict on one concern.
 *
 * This is the column the author cannot write. `verified: false` is a normal,
 * useful answer - it means the revision did not do what the reply says it did -
 * and it is recorded with a reason so the author knows what to change.
 */
export async function rereviewFinding(runDir, input, now) {
  const { file, current } = await readReviewRows(runDir)
  const existing = current.find((row) => row.id === String(input.id ?? '')) ?? null
  if (existing === null) {
    throw new ResearchError('UNKNOWN_FINDING', 'no finding named ' + JSON.stringify(String(input.id ?? '')) + ' - a re-review verifies something that was raised')
  }
  if (existing.status === 'open') {
    throw new ResearchError('NOT_ANSWERED', 'finding ' + existing.id + ' has no answer yet, so there is nothing for a re-review to verify: the author answers it first (action=answer)')
  }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') {
    throw new ResearchError('BAD_REPLY', 'a re-review verdict needs a `reason`: what in the revised document did or did not settle it')
  }
  const verified = input.verified === true
  const next = {
    ...existing,
    verified,
    verifiedBy: String(input.by ?? 'the re-review').trim().slice(0, 120) || 'the re-review',
    verifyReason: reason.slice(0, 1000),
    verifiedAt: stamp(now),
    revision: Number(existing.revision ?? 1) + 1,
  }
  await appendJsonl(file, next)
  return next
}

/**
 * The traceability matrix: one row per concern, with the author's claim and the
 * re-review's finding in separate columns.
 */
export function matrix(rows) {
  const current = foldLatest(rows, 'id').filter((row) => row.kind !== 'concession')
  return current
    .map((row) => ({
      id: row.id,
      round: Number(row.round) || 1,
      role: String(row.role ?? ''),
      severity: String(row.severity ?? 'major'),
      criterion: String(row.criterion ?? ''),
      concern: String(row.concern ?? ''),
      evidence: String(row.evidence ?? ''),
      status: String(row.status ?? 'open'),
      reply: String(row.reply ?? ''),
      verified: row.verified === true ? 'yes' : row.verified === false ? 'NO' : 'not re-reviewed',
      verifyReason: String(row.verifyReason ?? ''),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** The matrix as a Markdown table a person can paste into a response letter. */
export function renderMatrix(rows) {
  const entries = matrix(rows)
  const lines = ['| # | role | sev | criterion | concern | what was in the manuscript | your answer | verified |', '|---|---|---|---|---|---|---|---|']
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  for (const entry of entries) {
    lines.push(
      '| ' + entry.id + ' | ' + cell(entry.role) + ' | ' + cell(entry.severity) + ' | ' + cell(entry.criterion) + ' | ' + cell(entry.concern) + ' | ' + cell(entry.evidence) + ' | ' +
        (entry.status === 'open' ? '**still open**' : cell(entry.status) + ': ' + cell(entry.reply)) + ' | ' + cell(entry.verified) + ' |',
    )
  }
  return lines.join('\n')
}

/**
 * The round's report: the panel's concerns, grouped by criterion, with the counts
 * that decide whether the round is over.
 */
export function renderPanel(rows, options = {}) {
  const entries = matrix(rows).filter((entry) => options.round === undefined || entry.round === options.round)
  const open = entries.filter((entry) => entry.status === 'open')
  const major = entries.filter((entry) => entry.severity === 'major')
  const lines = [
    '# Review' + (options.round === undefined ? '' : ' — round ' + options.round) + (options.title === undefined ? '' : ': ' + options.title),
    '',
    entries.length + ' concern(s): ' + major.length + ' major, ' + open.length + ' still open.',
    '',
  ]
  for (const entry of entries) {
    lines.push('## ' + entry.id + ' [' + entry.severity + ', ' + entry.role + ', ' + entry.criterion + ']')
    lines.push(entry.concern)
    if (entry.evidence !== '') lines.push('', '*Where:* ' + entry.evidence)
    lines.push('', '*Answer:* ' + (entry.status === 'open' ? '**not answered yet**' : entry.status + ' — ' + entry.reply))
    lines.push('', '*Re-review:* ' + entry.verified + (entry.verifyReason === '' ? '' : ' — ' + entry.verifyReason))
    lines.push('')
  }
  const advocate = advocateHealth(rows ?? [])
  if (advocate.attacks + advocate.concessions > 0) {
    lines.push('## The devil\'s advocate')
    lines.push(advocate.attacks + ' attack(s), ' + advocate.concessions + ' concession(s), rate ' + Math.round(advocate.rate * 100) + '%.')
    if (advocate.warning) lines.push('', '**' + advocate.warning + '**')
  }
  return lines.join('\n')
}

/**
 * Whether the devil's advocate is doing its job, from its OWN record.
 *
 * A concession rate above half - over enough attacks to mean anything - is the
 * pattern the protocol was written for, and saying it out loud in the report is
 * the only way anyone notices: every individual concession looked reasonable.
 */
export function advocateHealth(rows) {
  const advocate = (rows ?? []).filter((row) => row !== null && row.role === 'devils-advocate')
  const concessions = advocate.filter((row) => row.kind === 'concession')
  const attacks = advocate.filter((row) => row.kind !== 'concession')
  const total = attacks.length + concessions.length
  const rate = total === 0 ? 0 : concessions.length / total
  const warning =
    total >= SYCOPHANCY_FLOOR && rate >= SYCOPHANCY_RATE
      ? 'The advocate has conceded ' + Math.round(rate * 100) + '% of the exchanges. Conceding is not the same as being answered: re-read the attacks it held and check whether the replies really carried evidence.'
      : ''
  return { attacks: attacks.length, concessions: concessions.length, rate, warning }
}