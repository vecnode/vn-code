// check-research-judge.mjs - the calibration of a JUDGE, and the arithmetic it rests
// on.
//
// The verification ladder records what a reader decided about a passage. This check
// is about the reader: a small set of items whose correct verdict is not in doubt,
// answered by somebody, and scored for the two errors that matter - accepting a
// claim the passage does not support (FNR), and rejecting one it does (FPR).
//
// What this file can prove, and what it cannot, is the whole point of writing it
// down:
//
//   - it CAN prove the gold set is well formed, that every label carries the reason
//     for it, that the labels are balanced the way a manuscript is, and that the
//     scoring is arithmetically right - hand-computed cases, a perfect judge, a
//     sycophant, a skeptic, and a judge sitting exactly on each threshold;
//   - it CANNOT prove that any judge is calibrated in general. A pass means somebody
//     agreed with 25 unambiguous items. That is worth knowing and is not evidence of
//     anything about a real manuscript, and no check can make it so.
//
// The threshold cases are the ones to keep: a rate that is exactly at the bar must
// FAIL, because "at or above" is what the constants say, and an off-by-one there is
// a judge that passes without meeting the stated policy.
//
// Run:  node packages/dsh-research/checks/check-research-judge.mjs
//       npm run check:judge        (from packages/dsh-research)
export {}

const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const pkgDir = path.join(repo, 'packages', 'dsh-research')
let failures = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(52) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

const calibration = await import(pathToFileURL(path.join(pkgDir, 'lib', 'calibration.js')).href)
const { GOLD_ITEMS, MIN_ITEMS, FNR_MAX, FPR_MAX, DEFECT_VERDICTS, ACCEPTABLE_VERDICTS, VERDICT_VALUES, STRENGTH_VALUES, publicItems, scoreVerdicts, renderCalibration, goldItem } = calibration

console.log('check-research-judge: the gold set, the scorer, and the thresholds it states')

// ---------------------------------------------------------------------------
// The gold set is well formed, and every label can be argued with
// ---------------------------------------------------------------------------
{
  check('the set is big enough to score at all', GOLD_ITEMS.length >= MIN_ITEMS, true)
  check('item ids are unique', new Set(GOLD_ITEMS.map((one) => one.id)).size, GOLD_ITEMS.length)
  check('every id is gNN', GOLD_ITEMS.every((one) => /^g[0-9]{2}$/.test(one.id)), true)
  check('every item has a claim and a passage', GOLD_ITEMS.every((one) => typeof one.claim === 'string' && one.claim.length > 20 && typeof one.passage === 'string' && one.passage.length > 20), true)
  check('every verdict is one the ledger uses', GOLD_ITEMS.every((one) => VERDICT_VALUES.includes(one.verdict)), true)
  check('every strength verdict is one the ledger uses', GOLD_ITEMS.every((one) => STRENGTH_VALUES.includes(one.strengthVerdict)), true)
  // The label a reader cannot argue with is a label nobody can correct, so the
  // reason is required and has to say something.
  check('every label carries the reason for it', GOLD_ITEMS.every((one) => typeof one.why === 'string' && one.why.length > 40), true)
  check('and no two items share a claim', new Set(GOLD_ITEMS.map((one) => one.claim)).size, GOLD_ITEMS.length)

  const defects = GOLD_ITEMS.filter((one) => DEFECT_VERDICTS.includes(one.verdict))
  const acceptable = GOLD_ITEMS.filter((one) => ACCEPTABLE_VERDICTS.includes(one.verdict))
  check('the set holds both defects and acceptable claims', defects.length > 0 && acceptable.length > 0, true)
  // A manuscript is mostly supportable claims, and a set that was evenly split would
  // teach a boundary that does not exist. The skew is asserted so it stays.
  check('and is skewed the way a manuscript is', acceptable.length > defects.length, true)
  check('every defect verdict is represented', DEFECT_VERDICTS.every((verdict) => GOLD_ITEMS.some((one) => one.verdict === verdict)), true)
  check('every acceptable verdict is represented', ACCEPTABLE_VERDICTS.every((verdict) => GOLD_ITEMS.some((one) => one.verdict === verdict)), true)
  check('a strength verdict varies across the set', new Set(GOLD_ITEMS.filter((one) => ACCEPTABLE_VERDICTS.includes(one.verdict)).map((one) => one.strengthVerdict)).size >= 3, true)

  // The line between `unsupported` and `contradicted`, and between `unsupported` and
  // `misattributed`, is where a judge is most likely to be wrong - so the set has to
  // contain an item for each side of each line.
  check('the set distinguishes "does not say" from "says the opposite"', GOLD_ITEMS.some((one) => one.verdict === 'unsupported') && GOLD_ITEMS.some((one) => one.verdict === 'contradicted'), true)
  check('and contains a misattribution, which no quote search can catch', GOLD_ITEMS.some((one) => one.verdict === 'misattributed'), true)

  // The items handed to a judge must NOT carry their labels: a calibration you can
  // read the answers out of is not a calibration.
  const handed = publicItems()
  check('a judge is handed every item', handed.length, GOLD_ITEMS.length)
  check('and each one carries only an id, a claim and a passage', handed.every((one) => Object.keys(one).sort().join(',') === 'claim,id,passage'), true)
  const leaked = handed.filter((one) => {
    const item = goldItem(one.id)
    return JSON.stringify(one).includes('"verdict"') || JSON.stringify(one).includes(item.strengthVerdict) || JSON.stringify(one).includes(item.why)
  })
  check('with no label, no strength verdict and no reason in it', leaked.length, 0)
}

// ---------------------------------------------------------------------------
// The arithmetic, on hand-computed cases
// ---------------------------------------------------------------------------
{
  const perfect = scoreVerdicts(GOLD_ITEMS.map((one) => ({ id: one.id, verdict: one.verdict, strengthVerdict: one.strengthVerdict, reason: 'read it' })))
  check('a perfect judge passes', perfect.verdict, 'calibrated')
  check('with no false negatives', perfect.fnr.rate, 0)
  check('and no false positives', perfect.fpr.rate, 0)
  check('and agrees on every strength verdict', perfect.strength.agreed + '/' + perfect.strength.scored, GOLD_ITEMS.filter((one) => ACCEPTABLE_VERDICTS.includes(one.verdict)).length + '/' + GOLD_ITEMS.filter((one) => ACCEPTABLE_VERDICTS.includes(one.verdict)).length)
  check('the denominators are the gold set\'s own', perfect.denominators.defects + '/' + perfect.denominators.acceptable, GOLD_ITEMS.filter((one) => DEFECT_VERDICTS.includes(one.verdict)).length + '/' + GOLD_ITEMS.filter((one) => ACCEPTABLE_VERDICTS.includes(one.verdict)).length)

  // The sycophant: everything is fine, nothing is ever wrong. This is the failure the
  // package exists to prevent, and it has to fail loudly.
  const sycophant = scoreVerdicts(GOLD_ITEMS.map((one) => ({ id: one.id, verdict: 'supported', strengthVerdict: 'aligned', reason: 'looks fine' })))
  check('a judge that accepts everything FAILS', sycophant.verdict, 'not-calibrated')
  check('on the false-negative side', sycophant.fnr.rate, 1)
  check('and is named for accepting defects', sycophant.fnr.ids.length, perfect.denominators.defects)

  // The skeptic: nothing is ever good enough. Annoying rather than dangerous, and it
  // is measured too, because a ladder an author argues with is a ladder they stop using.
  const skeptic = scoreVerdicts(GOLD_ITEMS.map((one) => ({ id: one.id, verdict: 'unsupported', strengthVerdict: 'overstated', reason: 'do not trust it' })))
  check('a judge that rejects everything FAILS', skeptic.verdict, 'not-calibrated')
  check('on the false-positive side', skeptic.fpr.rate, 1)

  // A judge that returns a wrong STRENGTH verdict is not making a support error, and
  // the two axes must not be confused: this one passes calibration and fails strength.
  const miswritten = scoreVerdicts(GOLD_ITEMS.map((one) => ({ id: one.id, verdict: one.verdict, strengthVerdict: one.strengthVerdict === 'aligned' ? 'overstated' : 'aligned', reason: 'read it' })))
  check('a wrong strength verdict is not a support error', miswritten.verdict, 'calibrated')
  check('but the strength axis shows it', miswritten.strength.agreed < miswritten.strength.scored, true)
  check('and the overstatement count is reported', miswritten.strength.overstated > 0, true)
}

// ---------------------------------------------------------------------------
// The thresholds: exactly at the bar is a FAILURE, because that is what "at or
// above" means, and an off-by-one here is a judge passing without meeting policy
// ---------------------------------------------------------------------------
{
  const defects = GOLD_ITEMS.filter((one) => DEFECT_VERDICTS.includes(one.verdict))
  const acceptable = GOLD_ITEMS.filter((one) => ACCEPTABLE_VERDICTS.includes(one.verdict))

  // Miss exactly one defect, in the most honest way available: call it partially
  // supported. One miss out of seven is 0.143, just under the 0.15 bar.
  const oneMiss = GOLD_ITEMS.map((one) => ({
    id: one.id,
    verdict: one.id === defects[0].id ? 'partially-supported' : one.verdict,
    strengthVerdict: one.strengthVerdict,
    reason: 'read it',
  }))
  const caused = scoreVerdicts(oneMiss)
  check('one missed defect in seven is under the bar', caused.fnr.rate < FNR_MAX, true)
  check('so the judge still passes', caused.verdict, 'calibrated')
  check('and the miss is named by id', caused.fnr.ids.join(','), defects[0].id)

  // Miss two: 0.286, over the bar.
  const twoMiss = GOLD_ITEMS.map((one) => ({
    id: one.id,
    verdict: defects.slice(0, 2).some((item) => item.id === one.id) ? 'partially-supported' : one.verdict,
    strengthVerdict: one.strengthVerdict,
    reason: 'read it',
  }))
  check('two missed defects is over the bar', scoreVerdicts(twoMiss).fnr.rate >= FNR_MAX, true)
  check('and that judge FAILS', scoreVerdicts(twoMiss).verdict, 'not-calibrated')

  // Reject one good claim in eighteen: 0.056, under the 0.10 bar.
  const oneReject = GOLD_ITEMS.map((one) => ({
    id: one.id,
    verdict: one.id === acceptable[0].id ? 'unsupported' : one.verdict,
    strengthVerdict: one.strengthVerdict,
    reason: 'read it',
  }))
  check('one rejected good claim in eighteen is under the bar', scoreVerdicts(oneReject).fpr.rate < FPR_MAX, true)
  check('so that judge still passes', scoreVerdicts(oneReject).verdict, 'calibrated')

  const twoReject = GOLD_ITEMS.map((one) => ({
    id: one.id,
    verdict: acceptable.slice(0, 2).some((item) => item.id === one.id) ? 'unsupported' : one.verdict,
    strengthVerdict: one.strengthVerdict,
    reason: 'read it',
  }))
  check('two rejected good claims is over the bar', scoreVerdicts(twoReject).fpr.rate >= FPR_MAX, true)
  check('and that judge FAILS', scoreVerdicts(twoReject).verdict, 'not-calibrated')

  // The constants are policy, and this is the assertion that says so out loud: if
  // somebody changes FNR_MAX to a number one miss would exceed, this fails and the
  // change has to be deliberate.
  const oneMissRate = scoreVerdicts(oneMiss).fnr.rate
  check('the FNR bar sits between one miss and two', oneMissRate < FNR_MAX && scoreVerdicts(twoMiss).fnr.rate >= FNR_MAX, true)
  const oneRejectRate = scoreVerdicts(oneReject).fpr.rate
  check('and the FPR bar between one rejection and two', oneRejectRate < FPR_MAX && scoreVerdicts(twoReject).fpr.rate >= FPR_MAX, true)
}

// ---------------------------------------------------------------------------
// A partial run is missing data, never a wrong answer
// ---------------------------------------------------------------------------
{
  const half = GOLD_ITEMS.slice(0, Math.floor(GOLD_ITEMS.length / 2))
  const partial = scoreVerdicts(half.map((one) => ({ id: one.id, verdict: one.verdict, strengthVerdict: one.strengthVerdict, reason: 'read it' })))
  check('a partial run is NOT scored as calibrated', partial.verdict, 'insufficient')
  check('and the unanswered items are named', partial.unscored.length, GOLD_ITEMS.length - half.length)
  check('while the answered ones are not counted as errors', partial.fnr.missed + partial.fpr.rejected, 0)
  check('the judged count is what was answered', partial.judged, half.length)

  const empty = scoreVerdicts([])
  check('an empty run scores nothing rather than throwing', empty.verdict, 'insufficient')
  check('and every item is listed as unanswered', empty.unscored.length, GOLD_ITEMS.length)

  const junk = scoreVerdicts([{ id: 'not-an-item', verdict: 'supported', reason: 'x' }, null, { id: 'g01', verdict: 'supported', reason: 'x' }])
  check('an id that is not an item is reported, not scored', junk.unknown.join(','), 'not-an-item')
  check('and a malformed entry does not throw', typeof junk.verdict, 'string')

  const nonsense = scoreVerdicts(GOLD_ITEMS.map((one) => ({ id: one.id, verdict: 'maybe', strengthVerdict: 'unsure', reason: 'x' })))
  check('a verdict outside the vocabulary counts as neither error', nonsense.fnr.missed + nonsense.fpr.rejected, 0)
  check('and shows up as disagreement instead', nonsense.disagreements.length, GOLD_ITEMS.length)
}

// ---------------------------------------------------------------------------
// The report a person reads
// ---------------------------------------------------------------------------
{
  const report = scoreVerdicts(GOLD_ITEMS.map((one) => (one.verdict === 'misattributed' ? { id: one.id, verdict: 'supported', strengthVerdict: 'aligned', reason: 'the quote is in the source' } : { id: one.id, verdict: one.verdict, strengthVerdict: one.strengthVerdict, reason: 'read it' })))
  const text = renderCalibration(report)
  check('the report names the FNR', text.includes('FNR'), true)
  check('and the FPR', text.includes('FPR'), true)
  check('and every gold class', VERDICT_VALUES.every((verdict) => text.includes(verdict)), true)
  check('and the disagreement, with the judge\'s own reason', text.includes('the judge\'s reason: the quote is in the source'), true)
  check('and the label\'s reason beside it', text.includes('why the label is what it is:'), true)
  check('and the verdict line', /VERDICT:/.test(text), true)
  // The one sentence that has to survive every edit: a pass is not a licence.
  check('and says what a pass does NOT mean', text.includes('does NOT mean the judge can spot a subtle overstatement'), true)
  check('a failing report says which bar was crossed', renderCalibration(scoreVerdicts(GOLD_ITEMS.map((one) => ({ id: one.id, verdict: 'supported', strengthVerdict: 'aligned', reason: 'x' })))).includes('too many defects accepted'), true)
}

console.log('')
console.log(failures === 0 ? 'all research-judge checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
