/**
 * dsh-research — how good is the reader?
 *
 * The verification ladder records what a READER decided: `r3-support` says "this
 * passage supports this sentence as written", and the ledger keeps the judge, the
 * reason and the passage so a second reader can disagree with a specific verdict.
 * What the ledger could not say was whether the reader was any good.
 *
 * This module makes that measurable, and it is the one place in this package where
 * a number is about a PERSON rather than about a document. A judge answers a small
 * set of items whose correct verdict is not in doubt, and the answers are scored
 * against the labels:
 *
 *   - **FNR** (false-negative rate): of the items that DO NOT support their claim,
 *     how many did the judge accept? This is the expensive error - it lets a
 *     fabricated or overstated claim through, which is the failure the whole
 *     package exists to prevent.
 *   - **FPR** (false-positive rate): of the items that DO support their claim, how
 *     many did the judge reject? This is the annoying error, and it is not harmless
 *     either: a judge that rejects good claims wastes revision rounds and teaches
 *     an author to distrust the ladder.
 *
 * Three things about this design are deliberate and worth stating.
 *
 * 1. **The labels are ours, and they are written down.** Every item carries the
 *    reason its verdict is what it is, so a reader can disagree with a label
 *    rather than having to trust one. An item nobody could disagree with is not a
 *    calibration item; it is a trick question, and there are none here.
 * 2. **The thresholds are policy, not physics.** They are constants in this file
 *    with the reasoning beside them, so a person can change them and see what
 *    changes.
 * 3. **Passing means very little.** A judge that agrees with twenty-five
 *    unambiguous items has shown it is not grossly miscalibrated. It has NOT shown
 *    it can spot a subtle overstatement in a real manuscript, and no fixed set
 *    could show that. The report says so in as many words, and this package does
 *    not gate anything on the result.
 */

/**
 * The floor for a sample worth scoring.
 *
 * Below this the confidence interval around any rate is wider than the rate, and a
 * number that uncertain is worse than no number: it invites a decision it cannot
 * support. Twenty is not statistics - it is the point where a single item stops
 * moving the rate by more than five points.
 */
export const MIN_ITEMS = 20

/**
 * The policy thresholds, and why these numbers.
 *
 * FNR ≥ .15 fails: a judge that accepts more than about one unsupported claim in
 * seven is letting defects through at a rate that makes the ladder decorative.
 * FPR ≥ .10 fails: rejecting more than one good claim in ten makes the ladder
 * something an author learns to argue with.
 *
 * Both are round numbers chosen to be arguable. What matters is that they are
 * STATED, and that the failure names which one was crossed.
 */
export const FNR_MAX = 0.15
export const FPR_MAX = 0.1

/** The verdicts that mean "the claim does not hold up". */
export const DEFECT_VERDICTS = ['unsupported', 'contradicted', 'misattributed']
/** The verdicts that mean "this claim is acceptable as written". */
export const ACCEPTABLE_VERDICTS = ['supported', 'partially-supported']
/** Every verdict a judge may return, in the order the tool documents them. */
export const VERDICT_VALUES = ['supported', 'partially-supported', 'unsupported', 'contradicted', 'misattributed']
/** The strength verdicts, which are a second axis and are scored separately. */
export const STRENGTH_VALUES = ['aligned', 'overstated', 'understated']

/**
 * The items.
 *
 * Synthetic on purpose: a calibration set built from real papers would drag in
 * their licences, their retractions and their reputations, and a label nobody is
 * allowed to change is not a label. Each item is a CLAIM and the PASSAGE it was
 * bound to, the verdict a careful reader should reach, and the reason - which is
 * the part that makes the label checkable.
 *
 * The set is deliberately unbalanced: a manuscript is, and a judge that only ever
 * sees even splits learns a decision boundary that does not exist in practice.
 * Seven items are defects and eighteen are acceptable, which is roughly what a run
 * of honest work looks like - and it is why the FNR denominator is the small one.
 */
export const GOLD_ITEMS = Object.freeze([
  {
    id: 'g01',
    claim: 'Programme participation was associated with higher completion.',
    passage: 'Completion was 12 percentage points higher among participants than among non-participants (95% CI 4 to 20).',
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: 'The passage reports the same association, in the same direction, with no causal verb - and the claim has none either.',
  },
  {
    id: 'g02',
    claim: 'The sample was recruited from two sites.',
    passage: 'Participants were recruited at two community colleges in the same state.',
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: 'Two named colleges are two sites; the claim says nothing the passage does not.',
  },
  {
    id: 'g03',
    claim: "The scale's internal consistency was .84.",
    passage: "Cronbach's alpha for the six-item scale was .84.",
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: 'The number in the claim is the number in the passage.',
  },
  {
    id: 'g04',
    claim: 'Attendance was below the pre-set threshold.',
    passage: 'Only 61% of sessions were attended, against a pre-specified threshold of 75%.',
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: '61% is below 75%, and the passage states both numbers and the comparison.',
  },
  {
    id: 'g05',
    claim: 'Two of the four outcomes improved.',
    passage: 'Of the four outcomes, attendance and course completion improved; grades and persistence did not.',
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: 'The passage counts the same two improvements out of the same four outcomes.',
  },
  {
    id: 'g06',
    claim: 'The trial was registered before enrolment began.',
    passage: 'The protocol was registered on 3 March 2024; the first participant was enrolled on 18 March 2024.',
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: 'The registration date precedes the enrolment date, which is exactly the claim.',
  },
  {
    id: 'g07',
    claim: 'The effect was not statistically significant after adjustment.',
    passage: 'After adjustment for prior attainment the estimate was 2.1 points (95% CI -1.4 to 5.6; p = .24).',
    verdict: 'supported',
    strengthVerdict: 'aligned',
    why: 'An interval that crosses zero and a p of .24 is a non-significant adjusted estimate.',
  },
  {
    id: 'g08',
    claim: 'The programme doubled completion.',
    passage: 'Completion rose from 18% to 24% among participants.',
    verdict: 'supported',
    strengthVerdict: 'overstated',
    why: 'The rise is supported; 18% to 24% is a third, not a double. The direction is fine and the magnitude is not.',
  },
  {
    id: 'g09',
    claim: 'Sleep restriction causes memory loss in adults.',
    passage: 'Adults reporting shorter sleep showed lower recall scores (r = .21).',
    verdict: 'supported',
    strengthVerdict: 'overstated',
    why: 'A correlation supports an association; "causes" is a verb this design cannot carry, whatever the p-value.',
  },
  {
    id: 'g10',
    claim: 'The intervention eliminated the attainment gap.',
    passage: 'The gap narrowed by 30% over the two-year period.',
    verdict: 'supported',
    strengthVerdict: 'overstated',
    why: 'Narrowing is supported; "eliminated" is the absence of a gap, which the passage does not report.',
  },
  {
    id: 'g11',
    claim: 'All participants improved.',
    passage: 'Mean scores improved; 64% of participants improved individually.',
    verdict: 'supported',
    strengthVerdict: 'overstated',
    why: 'The mean improved and the passage explicitly says only 64% of individuals did - "all" is contradicted by the denominator, not by the direction.',
  },
  {
    id: 'g12',
    claim: 'The findings prove the mechanism.',
    passage: 'The pattern of results is consistent with the proposed mechanism.',
    verdict: 'supported',
    strengthVerdict: 'overstated',
    why: 'Consistency with a mechanism is support for it; "prove" is a stronger claim than the passage makes.',
  },
  {
    id: 'g13',
    claim: 'There may be an association between the two.',
    passage: 'The association held in all three cohorts, in both directions of the exposure, and survived adjustment for every measured confounder.',
    verdict: 'supported',
    strengthVerdict: 'understated',
    why: 'The passage is much stronger than the claim: three cohorts and every measured confounder is not a "may be".',
  },
  {
    id: 'g14',
    claim: 'The evidence is limited to a single study.',
    passage: 'Eleven studies met the inclusion criteria, of which nine reported the same direction of effect.',
    verdict: 'supported',
    strengthVerdict: 'understated',
    why: 'Eleven studies is not a single study - the claim understates what the passage holds.',
  },
  {
    id: 'g15',
    claim: 'The programme improved completion in both states.',
    passage: 'Completion improved in the first state; in the second, the estimate was close to zero.',
    verdict: 'partially-supported',
    strengthVerdict: 'aligned',
    why: 'The passage supports one half of the claim and not the other, and the claim is a conjunction - so it is not supported as written, and it is not unsupported either.',
  },
  {
    id: 'g16',
    claim: 'Costs fell and outcomes improved.',
    passage: 'Costs per participant fell by 8%; the outcome measures were unchanged.',
    verdict: 'partially-supported',
    strengthVerdict: 'aligned',
    why: 'One conjunct is supported and the other is not.',
  },
  {
    id: 'g17',
    claim: 'The association held for men and women.',
    passage: 'The association was clear among women and weaker among men (interaction p = .08).',
    verdict: 'partially-supported',
    strengthVerdict: 'aligned',
    why: 'The claim says the association held in both groups; the passage reports a weaker effect in one, which is neither the same nor its absence.',
  },
  {
    id: 'g18',
    claim: 'The review found the intervention effective for reading and for mathematics.',
    passage: 'Effects were positive for reading; too few studies reported mathematics to pool.',
    verdict: 'partially-supported',
    strengthVerdict: 'aligned',
    why: 'Reading is supported; mathematics is unaddressed rather than negative.',
  },
  {
    id: 'g19',
    claim: 'The intervention reduced absenteeism.',
    passage: "The report describes the intervention's design, its cost, and the two districts where it ran.",
    verdict: 'unsupported',
    strengthVerdict: 'aligned',
    why: 'The passage is about the intervention and says nothing about absenteeism - the topic being close is not support.',
  },
  {
    id: 'g20',
    claim: 'The study measured long-term earnings.',
    passage: 'Outcomes were measured at six months; longer-term follow-up was outside the scope of this study.',
    verdict: 'unsupported',
    strengthVerdict: 'aligned',
    why: 'Six-month outcomes are not long-term earnings, and the passage says the longer term was not studied.',
  },
  {
    id: 'g21',
    claim: 'The scale has been validated in adolescents.',
    passage: 'The scale was developed and validated with adults aged 25 to 60 in a single urban sample.',
    verdict: 'unsupported',
    strengthVerdict: 'aligned',
    why: 'Validation in adults does not support a claim about adolescents. It does not contradict it either - nobody tested adolescents - and that difference is the whole point of this item.',
  },
  {
    id: 'g22',
    claim: 'The sample size was justified by a power calculation.',
    passage: 'Recruitment procedures and the achieved sample are described in Appendix B.',
    verdict: 'unsupported',
    strengthVerdict: 'aligned',
    why: 'The passage points at a description; it never mentions a power calculation, so the claim has nothing behind it.',
  },
  {
    id: 'g23',
    claim: 'The authors recommend a national rollout.',
    passage: 'The authors call for a larger trial before any wider adoption.',
    verdict: 'contradicted',
    strengthVerdict: 'aligned',
    why: 'The passage states the opposite recommendation, in the same terms - this is not an absence of support.',
  },
  {
    id: 'g24',
    claim: 'The association was positive.',
    passage: 'The association was negative and statistically significant (beta = -0.18, p = .01).',
    verdict: 'contradicted',
    strengthVerdict: 'aligned',
    why: 'The sign is the opposite, and the passage is unambiguous about it.',
  },
  {
    id: 'g25',
    claim: 'Among adolescents, the programme raised completion.',
    passage: 'Among adults returning to education, completion rose by 9 points; adolescent outcomes were not reported.',
    verdict: 'misattributed',
    strengthVerdict: 'aligned',
    why: 'The passage reports a rise and attributes it to a different population - the quote is real and the attribution is wrong, which is the failure a quote search alone can never catch.',
  },
])

/** The items as a judge sees them: no labels, and the count they have to answer. */
export function publicItems() {
  return GOLD_ITEMS.map((item) => ({ id: item.id, claim: item.claim, passage: item.passage }))
}

/** One item by id, or undefined. */
export function goldItem(id) {
  return GOLD_ITEMS.find((item) => item.id === id)
}

/** Whether a value is a verdict this set can score. */
export function isVerdict(value) {
  return typeof value === 'string' && VERDICT_VALUES.includes(value)
}

/** Whether a value is a strength verdict. */
export function isStrengthVerdict(value) {
  return typeof value === 'string' && STRENGTH_VALUES.includes(value)
}

/** A rate, rounded to three places so a report is stable between runs. */
function rate(part, whole) {
  if (whole === 0) return 0
  return Math.round((part / whole) * 1000) / 1000
}

/**
 * Score a judge's answers against the labels.
 *
 * Pure and total: it never throws, because a calibration report that crashed would
 * be a report nobody could read. Unanswered items are reported as `unscored` rather
 * than counted as wrong - an item the judge never answered is missing data, and
 * counting it as an error would make a partial run look like a bad judge.
 *
 * @param verdicts `[{ id, verdict, strengthVerdict }]`
 */
export function scoreVerdicts(verdicts) {
  const said = new Map()
  const unknown = []
  for (const entry of Array.isArray(verdicts) ? verdicts : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = String(entry.id ?? '').trim()
    if (goldItem(id) === undefined) {
      if (id !== '') unknown.push(id)
      continue
    }
    said.set(id, { verdict: String(entry.verdict ?? ''), strengthVerdict: String(entry.strengthVerdict ?? ''), reason: String(entry.reason ?? '').trim() })
  }

  const judged = GOLD_ITEMS.filter((item) => said.has(item.id))
  const unscored = GOLD_ITEMS.filter((item) => !said.has(item.id)).map((item) => item.id)

  const defects = GOLD_ITEMS.filter((item) => DEFECT_VERDICTS.includes(item.verdict))
  const acceptable = GOLD_ITEMS.filter((item) => ACCEPTABLE_VERDICTS.includes(item.verdict))

  // The false negative: a defect the judge ACCEPTED. Both halves are required - an
  // item the judge never answered must not be counted here, or a judge could fail by
  // submitting less.
  const missed = defects.filter((item) => {
    const answer = said.get(item.id)
    return answer !== undefined && ACCEPTABLE_VERDICTS.includes(answer.verdict)
  })
  const rejected = acceptable.filter((item) => {
    const answer = said.get(item.id)
    return answer !== undefined && DEFECT_VERDICTS.includes(answer.verdict)
  })

  const perClass = VERDICT_VALUES.map((gold) => {
    const items = GOLD_ITEMS.filter((item) => item.verdict === gold)
    const answered = items.filter((item) => said.has(item.id))
    const agreed = answered.filter((item) => said.get(item.id).verdict === gold)
    return { gold, of: items.length, answered: answered.length, agreed: agreed.length, rate: rate(agreed.length, answered.length) }
  })

  // The strength axis is scored only where the claim is ACCEPTABLE: on a claim that
  // does not hold up at all, "was it written too strongly" is not the question.
  const strengthRows = acceptable.filter((item) => said.has(item.id))
  const strength = {
    scored: strengthRows.length,
    agreed: strengthRows.filter((item) => said.get(item.id).strengthVerdict === item.strengthVerdict).length,
    overstated: strengthRows.filter((item) => said.get(item.id).strengthVerdict === 'overstated' && item.strengthVerdict !== 'overstated').length,
    understated: strengthRows.filter((item) => said.get(item.id).strengthVerdict === 'understated' && item.strengthVerdict !== 'understated').length,
  }

  const fnr = rate(missed.length, defects.length)
  const fpr = rate(rejected.length, acceptable.length)
  const verdict =
    judged.length < MIN_ITEMS ? 'insufficient' : fnr >= FNR_MAX || fpr >= FPR_MAX ? 'not-calibrated' : 'calibrated'

  const disagreements = judged
    .filter((item) => said.get(item.id).verdict !== item.verdict)
    .map((item) => ({ id: item.id, gold: item.verdict, said: said.get(item.id).verdict, judgeReason: said.get(item.id).reason, why: item.why }))

  return {
    schema: 1,
    judged: judged.length,
    total: GOLD_ITEMS.length,
    unscored,
    unknown,
    denominators: { defects: defects.length, acceptable: acceptable.length },
    fnr: { missed: missed.length, of: defects.length, rate: fnr, ids: missed.map((item) => item.id) },
    fpr: { rejected: rejected.length, of: acceptable.length, rate: fpr, ids: rejected.map((item) => item.id) },
    perClass,
    strength,
    thresholds: { fnr: FNR_MAX, fpr: FPR_MAX, minItems: MIN_ITEMS },
    verdict,
    disagreements,
  }
}

/** The report as the lines a person reads. */
export function renderCalibration(report) {
  const lines = [
    'Judge calibration: ' + report.judged + ' of ' + report.total + ' item(s) answered',
    '',
    'Errors that let a bad claim through (FNR): ' + report.fnr.missed + ' of ' + report.fnr.of + ' = ' + report.fnr.rate.toFixed(3) + (report.fnr.rate >= FNR_MAX ? '  <- at or above the ' + FNR_MAX + ' bar' : ''),
    'Errors that reject a good claim (FPR): ' + report.fpr.rejected + ' of ' + report.fpr.of + ' = ' + report.fpr.rate.toFixed(3) + (report.fpr.rate >= FPR_MAX ? '  <- at or above the ' + FPR_MAX + ' bar' : ''),
    'Strength verdicts agreed: ' + report.strength.agreed + ' of ' + report.strength.scored + ' (overstated ' + report.strength.overstated + ', understated ' + report.strength.understated + ')',
    '',
    'Per gold class:',
  ]
  for (const row of report.perClass) {
    lines.push('  ' + row.gold.padEnd(22) + row.agreed + '/' + row.answered + (row.answered < row.of ? ' (' + (row.of - row.answered) + ' unanswered)' : ''))
  }
  if (report.unscored.length > 0) {
    lines.push('')
    lines.push('Not answered (' + report.unscored.length + '): ' + report.unscored.join(', ') + ' - a missing answer is missing data, never an error.')
  }
  if (report.unknown.length > 0) {
    lines.push('')
    lines.push('Ignored: ' + report.unknown.join(', ') + ' are not items in this set.')
  }
  if (report.disagreements.length > 0) {
    lines.push('')
    lines.push('Where the judge and the labels differ:')
    for (const one of report.disagreements.slice(0, 12)) {
      lines.push('  ' + one.id + ': the label is `' + one.gold + '`, the judge said `' + one.said + '`')
      if (one.judgeReason !== undefined && one.judgeReason !== '') lines.push('      the judge\'s reason: ' + one.judgeReason)
      lines.push('      why the label is what it is: ' + one.why)
    }
    if (report.disagreements.length > 12) lines.push('  … and ' + (report.disagreements.length - 12) + ' more')
  }
  lines.push('')
  if (report.verdict === 'insufficient') {
    lines.push('VERDICT: not enough items answered to score. ' + report.thresholds.minItems + ' are the floor, because below it one item moves the rate by more than five points.')
  } else if (report.verdict === 'calibrated') {
    lines.push('VERDICT: within the stated bars (' + FNR_MAX + ' FNR, ' + FPR_MAX + ' FPR).')
    lines.push('This means the judge is not grossly miscalibrated on 25 unambiguous items.')
    lines.push('It does NOT mean the judge can spot a subtle overstatement in a real manuscript, and nothing in this package is gated on it.')
  } else {
    lines.push('VERDICT: outside the stated bars (' + FNR_MAX + ' FNR, ' + FPR_MAX + ' FPR) - ' + (report.fnr.rate >= FNR_MAX ? 'too many defects accepted' : 'too many good claims rejected') + '.')
    lines.push('Read the disagreements above rather than the rate: which items were missed says more than how many.')
  }
  return lines.join('\n')
}
