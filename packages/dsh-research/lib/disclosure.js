/**
 * dsh-research — the disclosure record.
 *
 * Authorship, ethics approval, funding, conflicts, data availability and the use of
 * AI are the statements a journal requires and a reader checks. They are also the
 * ones an author is most likely to write from memory at the last minute, and the
 * ones where a missing body, an absent reference number or an undeclared conflict
 * turns a paper into a finding.
 *
 * So they are a RECORD here, not a paragraph: `plan/disclosure.json`, written by
 * `rs_plan part=disclosure`, validated on the way in and again by `r0`, and printed
 * as `disclosure.md` inside the submission folder.
 *
 * THE RULE THIS MODULE IS BUILT AROUND: it can check that a statement is COMPLETE
 * and it cannot check that it is TRUE. It will refuse an approval with no approving
 * body and no reference ("a sentence nobody can check"), and it will never decide
 * whether a study needed approval, needed consent, or is exempt - that is an
 * institution's determination, and a plugin that made it would be answering for
 * somebody else. The reference beside the `research-ethics` skill says the same
 * thing at length.
 *
 * The record is deliberately NOT part of the document. A disclosure names people
 * and funders, and the manuscript a reviewer receives has to carry none of that -
 * which is also why `disclosure.md` is written BESIDE `title-page.md` rather than
 * into the manuscript, and why the package check asserts the manuscript never
 * contains a name from this record.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ResearchError } from './run.js'

/** Where the machine-readable record lives, beside the plan. */
export const DISCLOSURE_FILE = 'plan/disclosure.json'
/** The generated human view of that record. Never a source of truth. */
export const DISCLOSURE_MD = 'plan/disclosure.md'

/**
 * CRediT's fourteen contribution roles, as slugs.
 *
 * Closed, like every other vocabulary in this package, and it is CRediT's own list
 * rather than a shortened version of it: a contribution statement is only useful if
 * a reader recognises the terms. `creditLabel` prints the published wording.
 */
export const CREDIT_ROLES = [
  'conceptualization',
  'methodology',
  'software',
  'validation',
  'formal-analysis',
  'investigation',
  'resources',
  'data-curation',
  'writing-original-draft',
  'writing-review-editing',
  'visualization',
  'supervision',
  'project-administration',
  'funding-acquisition',
]

/** The published wording, for the matrix a person reads. */
export const CREDIT_LABELS = {
  conceptualization: 'Conceptualization',
  methodology: 'Methodology',
  software: 'Software',
  validation: 'Validation',
  'formal-analysis': 'Formal analysis',
  investigation: 'Investigation',
  resources: 'Resources',
  'data-curation': 'Data curation',
  'writing-original-draft': 'Writing – original draft',
  'writing-review-editing': 'Writing – review & editing',
  visualization: 'Visualization',
  supervision: 'Supervision',
  'project-administration': 'Project administration',
  'funding-acquisition': 'Funding acquisition',
}

/**
 * What the record can say about ethics approval.
 *
 * Note what is NOT here: `exempt`, `expedited` or `full-board` as a determination
 * this plugin makes. `exempt-declared` is the author recording what a BODY declared,
 * and the refusal below requires that body to be named - the point is that the
 * plugin never supplies the answer, only the shape of it.
 */
export const APPROVALS = ['approved', 'exempt-declared', 'not-required', 'not-applicable', 'pending']
/** How consent was taken, in the terms an ethics committee uses. */
export const CONSENT_FORMS = ['written', 'verbal', 'waived', 'not-applicable']
/** Where the data are, in the terms a data-availability statement uses. */
export const DATA_AVAILABILITY = ['open', 'on-request', 'restricted', 'none']
/** What a generative tool was used for. */
export const AI_SCOPES = ['none', 'writing', 'analysis', 'code', 'translation', 'multiple']

/** Every field the record may carry. Closed, like the method record. */
export const DISCLOSURE_FIELDS = ['authors', 'ethics', 'funding', 'conflicts', 'data', 'aiUse']

/** One message per refusal this module can raise, asserted by the package check. */
export const DISCLOSURE_CODES = ['BAD_DISCLOSURE', 'DISCLOSURE_INCOMPLETE']

const MAX_AUTHORS = 200
const MAX_NAME_CHARS = 200
const MAX_STATEMENT_CHARS = 2000

function bad(detail) {
  return new ResearchError('BAD_DISCLOSURE', detail)
}

function incomplete(detail) {
  return new ResearchError('DISCLOSURE_INCOMPLETE', detail)
}

/** A non-empty string, trimmed and capped. */
function text(value, field, max = MAX_STATEMENT_CHARS) {
  const out = typeof value === 'string' ? value.trim() : ''
  if (out === '') throw bad('`' + field + '` is a statement, so it cannot be empty - drop the field rather than leaving it blank')
  if (out.length > max) throw bad('`' + field + '` is at most ' + max + ' characters (got ' + out.length + ')')
  return out
}

/** An object with a closed set of keys, or a refusal naming the stray one. */
function closedObject(value, field, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad('`' + field + '` is an object: ' + allowed.join(', '))
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw bad('`' + field + '.' + key + '` is not a field of `' + field + '`. It holds ' + allowed.join(', '))
  }
  return value
}

/** A list of strings, each non-empty. */
function stringList(value, field, { min = 0, max = 50 } = {}) {
  if (!Array.isArray(value)) throw bad('`' + field + '` is a list of strings (got ' + JSON.stringify(value) + ')')
  if (value.length < min) throw bad('`' + field + '` needs at least ' + min + ' entr' + (min === 1 ? 'y' : 'ies'))
  if (value.length > max) throw bad('`' + field + '` holds at most ' + max + ' entries (got ' + value.length + ')')
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw bad('every entry of `' + field + '` is a string (got ' + JSON.stringify(entry) + ')')
    const out = entry.trim()
    if (out === '') throw bad('`' + field + '[' + index + ']` is empty - drop it rather than leaving a blank')
    if (out.length > MAX_NAME_CHARS) throw bad('an entry of `' + field + '` is at most ' + MAX_NAME_CHARS + ' characters (got ' + out.length + ')')
    return out
  })
}

/**
 * A disclosure record, validated, or a refusal that says which rule it broke.
 *
 * `BAD_DISCLOSURE` is a malformed field (a wrong type, an unknown key, a value
 * outside its vocabulary). `DISCLOSURE_INCOMPLETE` is a statement that is SHAPED
 * correctly and says nothing a reader can check: an approval with no body, a
 * consent said to be waived with no reason, "the data are open" with no address.
 * The two are different kinds of wrong and a caller can tell them apart.
 */
export function normalizeDisclosure(input) {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    throw bad('a disclosure record is an object: ' + DISCLOSURE_FIELDS.join(', ') + ' (`authors` is the only required field)')
  }
  for (const key of Object.keys(input)) {
    if (!DISCLOSURE_FIELDS.includes(key)) {
      throw bad('`' + key + '` is not a field of a disclosure record. It holds ' + DISCLOSURE_FIELDS.join(', '))
    }
  }
  if (input.authors === undefined || input.authors === null) {
    throw bad('`authors` is required: a disclosure is about people, and an authorship list is where it starts')
  }
  if (!Array.isArray(input.authors)) throw bad('`authors` is a list of { name, credit } (got ' + JSON.stringify(input.authors) + ')')
  if (input.authors.length === 0) throw incomplete('`authors` is empty - a submission with no author listed is a submission nobody is accountable for')
  if (input.authors.length > MAX_AUTHORS) throw bad('`authors` holds at most ' + MAX_AUTHORS + ' entries (got ' + input.authors.length + ')')

  const authors = input.authors.map((entry, index) => {
    const who = closedObject(entry, 'authors[' + index + ']', ['name', 'credit', 'orcid'])
    if (who.name === undefined || who.name === null) throw bad('`authors[' + index + '].name` is required')
    const name = text(who.name, 'authors[' + index + '].name', MAX_NAME_CHARS)
    if (who.credit === undefined || who.credit === null) {
      throw incomplete(
        'author ' + JSON.stringify(name) + ' has no `credit`: an author with no declared contribution is a name on a list. Name at least one CRediT role (' + CREDIT_ROLES.join(', ') + ')',
      )
    }
    const credit = stringList(who.credit, 'authors[' + index + '].credit', { min: 1, max: CREDIT_ROLES.length })
    for (const role of credit) {
      if (!CREDIT_ROLES.includes(role)) {
        throw bad('`' + role + '` is not a CRediT role. The fourteen are ' + CREDIT_ROLES.join(', '))
      }
    }
    const out = { name, credit }
    if (who.orcid !== undefined && who.orcid !== null && String(who.orcid).trim() !== '') {
      out.orcid = text(who.orcid, 'authors[' + index + '].orcid', 64)
    }
    return out
  })

  const record = { authors }

  if (input.ethics !== undefined && input.ethics !== null) {
    const ethics = closedObject(input.ethics, 'ethics', ['approval', 'body', 'reference', 'consent', 'notes'])
    if (ethics.approval === undefined || ethics.approval === null) throw bad('`ethics.approval` is required when `ethics` is given: one of ' + APPROVALS.join(', '))
    if (!APPROVALS.includes(ethics.approval)) {
      throw bad('`ethics.approval` is one of ' + APPROVALS.join(', ') + ' (got ' + JSON.stringify(String(ethics.approval)) + ') - this package does not decide which applies, it records what a body decided')
    }
    const block = { approval: ethics.approval }
    const needsBody = ethics.approval === 'approved' || ethics.approval === 'exempt-declared'
    if (needsBody) {
      if (ethics.body === undefined || ethics.body === null || String(ethics.body).trim() === '') {
        throw incomplete('an ethics `approval` of ' + ethics.approval + ' needs `body`: "approved" with no approving body is a sentence nobody can check')
      }
      if (ethics.reference === undefined || ethics.reference === null || String(ethics.reference).trim() === '') {
        throw incomplete('an ethics `approval` of ' + ethics.approval + ' needs `reference`: the number a reader would look up')
      }
      block.body = text(ethics.body, 'ethics.body', MAX_NAME_CHARS)
      block.reference = text(ethics.reference, 'ethics.reference', 120)
    } else {
      if (ethics.body !== undefined && ethics.body !== null) block.body = text(ethics.body, 'ethics.body', MAX_NAME_CHARS)
      if (ethics.reference !== undefined && ethics.reference !== null) block.reference = text(ethics.reference, 'ethics.reference', 120)
    }
    if (ethics.consent !== undefined && ethics.consent !== null) {
      if (!CONSENT_FORMS.includes(ethics.consent)) throw bad('`ethics.consent` is one of ' + CONSENT_FORMS.join(', ') + ' (got ' + JSON.stringify(String(ethics.consent)) + ')')
      block.consent = ethics.consent
    } else if (needsBody) {
      throw incomplete('an ethics `approval` of ' + ethics.approval + ' needs `consent`: how participants were asked, or why they were not')
    }
    if (ethics.notes !== undefined && ethics.notes !== null && String(ethics.notes).trim() !== '') block.notes = text(ethics.notes, 'ethics.notes')
    if (block.consent === 'waived' && block.notes === undefined) {
      throw incomplete('consent recorded as `waived` needs `notes`: a waiver is a decision somebody made and a reader needs to know on what basis')
    }
    record.ethics = block
  }

  if (input.funding !== undefined && input.funding !== null) {
    if (!Array.isArray(input.funding)) throw bad('`funding` is a list of { funder, grant } (got ' + JSON.stringify(input.funding) + ')')
    // An EMPTY list is a statement - "there is no funding to declare" - and is
    // deliberately different from leaving the field out, which says nobody recorded
    // it. The same distinction the method record draws for `exclude`.
    record.funding = input.funding.map((entry, index) => {
      const item = closedObject(entry, 'funding[' + index + ']', ['funder', 'grant', 'role'])
      if (item.funder === undefined || item.funder === null) throw bad('`funding[' + index + '].funder` is required')
      const out = { funder: text(item.funder, 'funding[' + index + '].funder', MAX_NAME_CHARS) }
      if (item.grant !== undefined && item.grant !== null && String(item.grant).trim() !== '') out.grant = text(item.grant, 'funding[' + index + '].grant', 120)
      if (item.role !== undefined && item.role !== null && String(item.role).trim() !== '') out.role = text(item.role, 'funding[' + index + '].role', 300)
      return out
    })
  }

  if (input.conflicts !== undefined && input.conflicts !== null) {
    if (input.conflicts === 'none') {
      record.conflicts = 'none'
    } else if (Array.isArray(input.conflicts)) {
      record.conflicts = input.conflicts.map((entry, index) => {
        const item = closedObject(entry, 'conflicts[' + index + ']', ['author', 'what'])
        if (item.author === undefined || item.author === null) throw bad('`conflicts[' + index + '].author` is required')
        if (item.what === undefined || item.what === null) throw bad('`conflicts[' + index + '].what` is required')
        return { author: text(item.author, 'conflicts[' + index + '].author', MAX_NAME_CHARS), what: text(item.what, 'conflicts[' + index + '].what') }
      })
    } else {
      throw bad('`conflicts` is either the string "none" or a list of { author, what } (got ' + JSON.stringify(input.conflicts) + ')')
    }
  }

  if (input.data !== undefined && input.data !== null) {
    const data = closedObject(input.data, 'data', ['availability', 'location', 'reason'])
    if (data.availability === undefined || data.availability === null) throw bad('`data.availability` is required when `data` is given: one of ' + DATA_AVAILABILITY.join(', '))
    if (!DATA_AVAILABILITY.includes(data.availability)) throw bad('`data.availability` is one of ' + DATA_AVAILABILITY.join(', ') + ' (got ' + JSON.stringify(String(data.availability)) + ')')
    const block = { availability: data.availability }
    const shareable = data.availability === 'open' || data.availability === 'on-request'
    if (shareable) {
      if (data.location === undefined || data.location === null || String(data.location).trim() === '') {
        throw incomplete(
          '`data.availability` of ' + data.availability + ' needs `location`: "' +
            (data.availability === 'on-request' ? 'available on request' : 'openly available') +
            '" with no address is a statement a reader is entitled to read as "not available"',
        )
      }
      block.location = text(data.location, 'data.location')
    } else {
      if (data.reason === undefined || data.reason === null || String(data.reason).trim() === '') {
        throw incomplete('`data.availability` of ' + data.availability + ' needs `reason`: a restriction a reader cannot understand is a restriction they will suspect')
      }
      block.reason = text(data.reason, 'data.reason')
      if (data.location !== undefined && data.location !== null && String(data.location).trim() !== '') block.location = text(data.location, 'data.location')
    }
    record.data = block
  }

  if (input.aiUse !== undefined && input.aiUse !== null) {
    const ai = closedObject(input.aiUse, 'aiUse', ['used', 'tools', 'scope', 'disclosure'])
    if (typeof ai.used !== 'boolean') throw bad('`aiUse.used` is true or false (got ' + JSON.stringify(ai.used) + ')')
    const block = { used: ai.used }
    if (ai.used === true) {
      if (ai.tools === undefined || ai.tools === null) throw incomplete('a declaration that a generative tool WAS used needs `tools`: which ones, by name')
      block.tools = stringList(ai.tools, 'aiUse.tools', { min: 1, max: 20 })
      if (ai.scope === undefined || ai.scope === null) throw incomplete('a declaration that a generative tool WAS used needs `scope`: what it was used for, one of ' + AI_SCOPES.join(', '))
      if (!AI_SCOPES.includes(ai.scope) || ai.scope === 'none') throw bad('`aiUse.scope` is one of ' + AI_SCOPES.filter((one) => one !== 'none').join(', ') + ' when a tool was used (got ' + JSON.stringify(String(ai.scope)) + ')')
      block.scope = ai.scope
    } else {
      if (ai.tools !== undefined && ai.tools !== null) throw bad('`aiUse.used: false` with `tools` contradicts itself - either a tool was used or it was not')
      if (ai.scope !== undefined && ai.scope !== null && ai.scope !== 'none') {
        throw bad('`aiUse.used: false` with `scope: ' + JSON.stringify(String(ai.scope)) + '` contradicts itself - either a tool was used or it was not')
      }
      block.scope = 'none'
    }
    if (ai.disclosure !== undefined && ai.disclosure !== null && String(ai.disclosure).trim() !== '') {
      block.disclosure = text(ai.disclosure, 'aiUse.disclosure')
    }
    record.aiUse = block
  }

  return record
}

/**
 * What is wrong with a record ALREADY ON DISK, as r0 problems.
 *
 * Lenient where `normalizeDisclosure` is strict, for the same reason the method
 * record is: this reads a file a person may have edited by hand. An unknown CRediT
 * role is an ERROR here even though it is only a refusal on the way in, because a
 * role the matrix cannot print is a contribution that silently disappears from the
 * artifact - and a declaration that contradicts itself is an error for the same
 * reason a screening count that increases is one.
 */
export function disclosureProblems(record) {
  const problems = []
  if (record === null || record === undefined) return problems
  if (typeof record !== 'object' || Array.isArray(record)) {
    return [{ code: 'disclosure-incomplete', severity: 'error', detail: DISCLOSURE_FILE + ' is not an object: expected ' + DISCLOSURE_FIELDS.join(', ') }]
  }
  const missing = []
  const authors = Array.isArray(record.authors) ? record.authors : null
  if (authors === null || authors.length === 0) {
    missing.push('authors')
  } else {
    for (const author of authors) {
      const name = author !== null && typeof author === 'object' && typeof author.name === 'string' ? author.name : '(unnamed)'
      const credit = author !== null && typeof author === 'object' && Array.isArray(author.credit) ? author.credit : []
      if (credit.length === 0) {
        problems.push({
          code: 'disclosure-incomplete',
          severity: 'warning',
          detail: DISCLOSURE_FILE + ': author ' + JSON.stringify(name) + ' has no declared contribution, so the matrix prints a name with no role',
        })
        continue
      }
      const unknown = credit.filter((role) => !CREDIT_ROLES.includes(role))
      if (unknown.length > 0) {
        problems.push({
          code: 'disclosure-role',
          severity: 'error',
          detail: DISCLOSURE_FILE + ': author ' + JSON.stringify(name) + ' carries ' + unknown.map((role) => JSON.stringify(String(role))).join(', ') + ', which ' + (unknown.length === 1 ? 'is not a CRediT role' : 'are not CRediT roles') + ' - the matrix cannot print it, and a contribution that disappears from the artifact is worse than one that was never claimed',
        })
      }
    }
  }
  const ethics = record.ethics
  if (ethics !== null && ethics !== undefined && typeof ethics === 'object' && !Array.isArray(ethics)) {
    const approval = String(ethics.approval ?? '')
    if (approval === '') missing.push('ethics.approval')
    const needsBody = approval === 'approved' || approval === 'exempt-declared'
    if (needsBody && (ethics.body === undefined || String(ethics.body).trim() === '')) {
      problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': the ethics approval names no approving `body`, so a reader cannot check it' })
    }
    if (needsBody && (ethics.reference === undefined || String(ethics.reference).trim() === '')) {
      problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': the ethics approval names no `reference` number' })
    }
    if (needsBody && (ethics.consent === undefined || String(ethics.consent).trim() === '')) {
      problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': no `consent` is recorded for a study with human participants' })
    }
    if (ethics.consent === 'waived' && (ethics.notes === undefined || String(ethics.notes).trim() === '')) {
      problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': consent is recorded as waived with no `notes` saying on what basis' })
    }
  }
  const data = record.data
  if (data !== null && data !== undefined && typeof data === 'object' && !Array.isArray(data)) {
    const availability = String(data.availability ?? '')
    if (availability === '') missing.push('data.availability')
    else if (availability === 'open' || availability === 'on-request') {
      if (data.location === undefined || String(data.location).trim() === '') {
        problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': data are declared ' + availability + ' with no `location`' })
      }
    } else if (availability === 'restricted' || availability === 'none') {
      if (data.reason === undefined || String(data.reason).trim() === '') {
        problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': data are declared ' + availability + ' with no `reason`' })
      }
    }
  }
  const ai = record.aiUse
  if (ai !== null && ai !== undefined && typeof ai === 'object' && !Array.isArray(ai)) {
    if (ai.used === false && ((Array.isArray(ai.tools) && ai.tools.length > 0) || (ai.scope !== undefined && ai.scope !== 'none'))) {
      problems.push({ code: 'disclosure-contradiction', severity: 'error', detail: DISCLOSURE_FILE + ': `aiUse.used` is false while tools or a scope are declared - the declaration contradicts itself' })
    }
    if (ai.used === true && (ai.tools === undefined || (Array.isArray(ai.tools) && ai.tools.length === 0))) {
      problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ': a tool is declared as used with no `tools` named' })
    }
  }
  if (missing.length > 0) {
    problems.push({ code: 'disclosure-incomplete', severity: 'warning', detail: DISCLOSURE_FILE + ' does not say ' + missing.join(', '), fields: missing })
  }
  return problems
}

/**
 * The record, read from disk.
 *
 * A missing file is `null` and is NOT a defect: a paper with no human participants,
 * no funding and no tool use has little to declare, and a rung that failed a run
 * for not having a record would be inventing a requirement the same way the method
 * record deliberately does not. A file that does not PARSE is reported to the
 * caller, which turns it into an r0 problem rather than a thrown error.
 */
export async function readDisclosureRecord(runDir) {
  const file = path.join(runDir, ...DISCLOSURE_FILE.split('/'))
  const text = await fsp.readFile(file, 'utf8').catch(() => null)
  if (text === null) return { record: null, file, exists: false, problem: null }
  try {
    return { record: JSON.parse(text), file, exists: true, problem: null }
  } catch (err) {
    return {
      record: null,
      file,
      exists: true,
      problem: { code: 'disclosure-incomplete', severity: 'error', detail: DISCLOSURE_FILE + ' is not valid JSON: ' + String(err && err.message ? err.message : err) },
    }
  }
}

/** The CRediT matrix: one row per role somebody claims, in CRediT's own order. */
export function creditMatrix(record) {
  const authors = record !== null && record !== undefined && Array.isArray(record.authors) ? record.authors : []
  const rows = []
  for (const role of CREDIT_ROLES) {
    const who = authors.filter((author) => Array.isArray(author.credit) && author.credit.includes(role)).map((author) => author.name)
    if (who.length > 0) rows.push({ role, label: CREDIT_LABELS[role], authors: who })
  }
  return rows
}

/**
 * The record as the artifact a journal asks for.
 *
 * It says it is GENERATED from `plan/disclosure.json`, because a hand-edit of this
 * file is a change the next build overwrites - and it says what is NOT recorded,
 * because an absent statement and a statement of absence are different things and
 * only one of them is a disclosure.
 */
export function renderDisclosure(record) {
  const notRecorded = '**Not recorded.** This run has no record of it; the author has to decide what it says.'
  const lines = [
    '<!-- GENERATED from plan/disclosure.json by rs_build format=package. Edit the RECORD, not this file. -->',
    '',
    '# Disclosure',
    '',
    'Assembled from the run\'s own record. Every statement below is the author\'s; the',
    'builder checks that a statement is **complete**, and cannot check that it is true.',
    '',
    '## Authors and contributions',
    '',
  ]
  const authors = Array.isArray(record.authors) ? record.authors : []
  lines.push('| author | CRediT roles |')
  lines.push('|---|---|')
  for (const author of authors) {
    const roles = (Array.isArray(author.credit) ? author.credit : []).map((role) => CREDIT_LABELS[role] ?? role)
    lines.push('| ' + author.name + (author.orcid === undefined ? '' : ' (' + author.orcid + ')') + ' | ' + (roles.join(', ') || '—') + ' |')
  }
  lines.push('', '### Contribution matrix', '')
  const matrix = creditMatrix(record)
  if (matrix.length === 0) lines.push('_No contribution is recorded._')
  else {
    lines.push('| CRediT role | author(s) |')
    lines.push('|---|---|')
    for (const row of matrix) lines.push('| ' + row.label + ' | ' + row.authors.join(', ') + ' |')
  }

  lines.push('', '## Ethics', '')
  if (record.ethics === undefined) {
    lines.push(notRecorded)
    lines.push('')
    lines.push('> This package does not decide whether a study needed approval, needed consent, or was exempt. Whether one applies is the researcher\'s institution\'s determination, and the honest thing to record is what that body said.')
  } else {
    const ethics = record.ethics
    lines.push('- **Approval**: ' + ethics.approval.replace(/-/g, ' '))
    if (ethics.body !== undefined) lines.push('- **Approving body**: ' + ethics.body)
    if (ethics.reference !== undefined) lines.push('- **Reference**: ' + ethics.reference)
    if (ethics.consent !== undefined) lines.push('- **Consent**: ' + ethics.consent)
    if (ethics.notes !== undefined) lines.push('- **Notes**: ' + ethics.notes)
  }

  lines.push('', '## Funding', '')
  if (record.funding === undefined) lines.push(notRecorded)
  else if (record.funding.length === 0) lines.push('None to declare. The author recorded that this work had no funding.')
  else {
    lines.push('| funder | grant | role |')
    lines.push('|---|---|---|')
    for (const item of record.funding) lines.push('| ' + item.funder + ' | ' + (item.grant ?? '—') + ' | ' + (item.role ?? '—') + ' |')
  }

  lines.push('', '## Conflicts of interest', '')
  if (record.conflicts === undefined) lines.push(notRecorded)
  else if (record.conflicts === 'none') lines.push('None to declare.')
  else if (record.conflicts.length === 0) lines.push('None to declare.')
  else for (const item of record.conflicts) lines.push('- **' + item.author + '**: ' + item.what)

  lines.push('', '## Data availability', '')
  if (record.data === undefined) lines.push(notRecorded)
  else {
    const data = record.data
    lines.push('- **Availability**: ' + data.availability.replace(/-/g, ' '))
    if (data.location !== undefined) lines.push('- **Where**: ' + data.location)
    if (data.reason !== undefined) lines.push('- **Why not**: ' + data.reason)
  }

  lines.push('', '## Use of generative AI', '')
  if (record.aiUse === undefined) lines.push(notRecorded)
  else if (record.aiUse.used === false) lines.push('No generative AI tool was used in this work. The author recorded that declaration.')
  else {
    lines.push('- **Tools**: ' + (record.aiUse.tools ?? []).join(', '))
    lines.push('- **Used for**: ' + String(record.aiUse.scope ?? '').replace(/-/g, ' '))
    if (record.aiUse.disclosure !== undefined) lines.push('- **Statement as it should appear**: ' + record.aiUse.disclosure)
  }
  lines.push('')
  lines.push('> Check the venue\'s own policy before submitting: what has to be disclosed, and')
  lines.push('> where, differs between journals, and a statement in the wrong place is a')
  lines.push('> statement the editor never sees.')
  return lines.join('\n').trimEnd() + '\n'
}

/** The record as one line, for a report or a tool's answer. */
export function disclosureSummary(record) {
  if (record === null || record === undefined) return 'nothing recorded'
  const bits = [record.authors.length + ' author(s)']
  bits.push(record.ethics === undefined ? 'no ethics statement' : 'ethics ' + String(record.ethics.approval).replace(/-/g, ' '))
  if (record.funding !== undefined) bits.push(record.funding.length === 0 ? 'no funding' : record.funding.length + ' funder(s)')
  if (record.conflicts !== undefined) bits.push(record.conflicts === 'none' || record.conflicts.length === 0 ? 'no conflicts' : record.conflicts.length + ' conflict(s)')
  if (record.data !== undefined) bits.push('data ' + String(record.data.availability).replace(/-/g, ' '))
  if (record.aiUse !== undefined) bits.push(record.aiUse.used === true ? 'AI use declared' : 'no AI use')
  return bits.join(', ')
}
