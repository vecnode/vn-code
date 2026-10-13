# Method — the dense version

This is the reference beside `research-methods`. It holds the content a run needs
before it writes a sentence that reports a design, a search or a number. It is
organised as a sequence of decisions, because that is the order they are actually
made in: the question, the design, the sample, the measurement, the analysis, the
report, the obligations.

Nothing here is this plugin's opinion. Where a rule comes from a published
standard the standard is named, so a reader can go and disagree with it — which is
the only way a method note is worth anything.

## 1. The question, made falsifiable

A research question is not a topic. "Sleep and memory" is a topic; "does one night
of sleep restriction reduce next-day recall in healthy adults?" is a question,
because there is an observation that would settle it either way.

**FINER** is the usual filter, and it is worth applying in writing:

| | the test | the failure it catches |
|---|---|---|
| **F**easible | can it be answered with the subjects, data, time and skill available? | a question nobody can run |
| **I**nteresting | does the answer change what someone does or believes? | a question already settled |
| **N**ovel | does it add to what is known — a new population, mechanism, method, or a contradiction to resolve? | a replication nobody asked for |
| **E**thical | can it be answered without harm or rights violations? | a question that cannot be approved |
| **R**elevant | to a field, a practice, a policy, or a theory? | a question with no audience |

**Structure the question by design**, because the structure is what makes the
search and the analysis follow from it:

| framework | for | the parts |
|---|---|---|
| **PICO** | trials and comparative studies | Population, Intervention, Comparator, Outcome |
| **PECO** | observational exposure studies | Population, Exposure, Comparator, Outcome |
| **PICOS / PICOTS** | reviews that must fix study design or timing | PICO plus Study design / Timing |
| **SPIDER** | qualitative and mixed-methods reviews | Sample, Phenomenon of Interest, Design, Evaluation, Research type |
| **PICo** | qualitative reviews | Population, phenomenon of Interest, Context |

Write the question into `plan/rq.md` as ONE sentence you could falsify. Gate
`g1-rq` shows that sentence to the person precisely because a question the author
has not read back is the wrong thing to build a document on.

**And write down what would falsify it.** A question with no possible
disconfirming observation is a thesis, not a research question — and it is the
single most common reason a "study" cannot fail and therefore cannot inform.

## 2. The design, and what it can support

The design is what licenses the verb. Everything else in this document is
secondary to that.

| design | what it estimates | can carry | the threat that matters most |
|---|---|---|---|
| **randomised controlled trial** | the effect of the intervention, on average | `causal` | weak allocation concealment; attrition that differs by arm |
| **cluster-randomised trial** | the effect, accounting for clustering | `causal` | analysing individuals as if independent |
| **crossover trial** | within-person effect | `causal` | carry-over; period effects; unblinding |
| **quasi-experiment** (difference-in-differences, regression discontinuity, instrumental variables) | the effect **under stated assumptions** | `causal`, assumptions named | the counterfactual is assumed, not created |
| **interrupted time series** | change in level and slope at an interruption | `associational` to `causal` | co-interventions at the same moment |
| **prospective cohort** | incidence and association; can support prediction | `associational` | confounding by indication; differential loss to follow-up |
| **case-control** | association with a rare outcome | `associational` | recall and selection of controls |
| **cross-sectional** | prevalence and co-occurrence, at one time | `associational` at most | cannot order cause and effect at all |
| **single-group pre-post** | change over time | `associational` at most | regression to the mean; history; maturation |
| **case series / case report** | description; hypothesis generation | `descriptive` | no denominator |
| **qualitative** (interviews, focus groups, ethnography, case study) | meaning, mechanism, experience, process | `descriptive`, `theoretical` | researcher framing; no prevalence may be inferred |
| **mixed methods** | both, deliberately integrated | per strand | the strands never actually meet in the discussion |
| **secondary data analysis** | whatever the original design supports | per original design | the question was not the one the data was collected for |
| **modelling / simulation / derivation** | what follows from the assumptions | `theoretical` | assumptions presented as findings |
| **systematic review / meta-analysis** | the body of evidence, on a stated question | `associational` to `causal` per included designs | a precise estimate of a biased literature |

Three rules that follow, and that reviewers check first:

1. **Name the counterfactual.** A causal claim needs a comparison group that
   would have been the same, absent the exposure. If you cannot say why it would
   be, the claim is `associational`.
2. **`p < .05` does not upgrade a design.** Significance is about precision, not
   about identification. A cross-sectional study with p = .0001 still cannot say
   "causes".
3. **Do not infer a design from a word.** "Trial" in a title, "cohort" in an
   abstract, "experiment" in a press release — read the methods before labelling
   the study, and before choosing its reporting guideline.

### The validity you have to argue for

| kind | the question | typical threats |
|---|---|---|
| **internal** | is the comparison fair? | confounding, selection, attrition, instrumentation, maturation, regression to the mean, testing effects |
| **external** | to whom, where and when does this generalise? | a sample of convenience; a single site; an era-bound effect |
| **construct** | does the measure mean what the claim says it means? | a proxy treated as the construct; a scale used outside its validated population |
| **statistical** | is the analysis the one the design implies? | multiplicity, violated assumptions, a model that ignores clustering, low power |

Report them under **Limitations** with what you did about each. A limitation
nobody addresses is a finding a reader will discount the whole paper for.

## 3. The sample, and the number

**Sampling.** Probability sampling (simple, systematic, stratified, cluster)
supports generalisation; non-probability sampling (convenience, purposive,
snowball, quota) supports description and hypothesis generation. Say which you
used, and do not use the language of the first to describe the second.

**Size, for a quantitative study.** The defensible route is a calculation, not a
rule of thumb:

- state the **target power** (conventionally ≥ .80), the **alpha** (a priori,
  conventionally .05, two-sided), the **smallest effect worth detecting**, and the
  design's allocation and clustering;
- for a non-significant result, report the **minimum detectable effect size** the
  sample could have found, because "no effect" from an underpowered study is not
  evidence of no effect;
- observed/post-hoc power is a transformation of the p-value and adds nothing —
  the sensitivity analysis is what a reader needs.

Rules of thumb exist and are not a substitution for the calculation: roughly
10–20 observations per predictor in a regression; roughly 10 events per variable
in logistic regression; a few hundred cases for a structural model; at least 30
units at the highest level of a multilevel model. Cite the rule you used and its
source, or calculate.

**Size, for a qualitative study.** The criterion is **saturation** — the point at
which further data stop producing new codes — not a number. Say how saturation was
judged, by whom, and what was still being found when you stopped. "n = 20" is not
a justification.

**Missing data.** Distinguish the mechanism, and it decides the method:

| mechanism | means | defensible handling |
|---|---|---|
| **MCAR** | missingness is unrelated to anything measured | complete-case analysis is unbiased (and wasteful) |
| **MAR** | missingness depends on observed variables | multiple imputation, or full-information maximum likelihood |
| **MNAR** | missingness depends on the unobserved value itself | model the mechanism, or bound the result with a sensitivity analysis |

Report the amount, the mechanism you assume, the method, and — the step most
often skipped — **whether the conclusion survives a different handling of the
same data.**

## 4. Measurement, and the bias in it

- **Reliability** (does it repeat?) and **validity** (does it mean what it
  claims?) are different properties, and a reliable instrument can be invalid.
- Report the instrument's provenance: validated in whom, in what language, and
  with what cut-off. A cut-off borrowed from another population is an assumption.
- **Blinding**: who was blinded to what — participants, providers, assessors,
  analysts. An unblinded outcome assessor is a measured bias, and the direction is
  usually toward the hypothesis.
- **Preregistered outcomes are primary; everything else is secondary or
  exploratory, and must be labelled as such.** The failure this prevents has a
  name — **HARKing**, hypothesising after the results are known — and it converts
  a chance finding into a confident one without any dishonesty in the writing.
- **Units and scale** belong in the text with the number: what was measured, in
  what unit, on what scale, over what period, and with what precision.

## 5. Reporting guidelines, routed by design

The EQUATOR Network indexes these. Pick by design — the guideline that owes your
study an account is the one your design maps to, not the one whose name you
recognise.

| the study is | the guideline | note |
|---|---|---|
| randomised trial | **CONSORT** | plus SPIRIT for the protocol |
| observational study | **STROBE** | cohort, case-control, cross-sectional |
| systematic review | **PRISMA 2020** | plus PRISMA-P for the protocol, PRISMA-ScR for scoping reviews |
| diagnostic accuracy | **STARD** | |
| prediction model | **TRIPOD** | |
| qualitative study | **COREQ** or **SRQR** | interviews/focus groups; the other covers a wider range |
| case report | **CARE** | |
| quality improvement | **SQUIRE 2.0** | |
| economic evaluation | **CHEERS** | |
| animal study | **ARRIVE** | |
| practice guideline | **AGREE II** | |
| a study that straddles two | both, and say where they conflict | a trial reported inside a review follows both |

Two rules about guidelines, both learned the hard way:

- **A guideline is a reporting contract, not a quality score.** Filling in every
  item does not make a study good; it makes its weaknesses visible, which is the
  point.
- **An unmet item is a sentence in Limitations, not a silence.** "We could not
  blind the outcome assessor because the intervention was behavioural" is a
  limitation a reader can weigh. Omitting it is a defect they cannot see, and the
  one thing a reporting guideline exists to prevent.

## 6. Statistics, reported so a reader can check them

The reporting bar, in the order a reviewer looks:

1. **Every test comes with an effect size and an interval.** Significance answers
   "is there something"; the effect size answers "how much", which is the question
   a reader has. A test statistic with no effect size is an incomplete result.
2. **Report the exact p-value** (`p = .032`, not `p < .05`), with the alpha level
   declared in advance. `p = .000` is what a program prints after rounding — no
   test produces a probability of exactly zero; write `p < .001`. This plugin
   refuses it at the ledger, see `research-methods`.
3. **Report the confidence interval and read its width.** A wide interval that
   excludes zero is a precise-enough estimate of *a* positive effect and a
   hopeless estimate of *how big*. The common omission is checking only whether
   the interval contains zero.
4. **Say how many comparisons you made.** Three or more groups compared by
   repeated t-tests, outcomes fished from a battery, subgroups chosen after
   looking — each inflates the chance of a false positive. Correct with
   Bonferroni or Holm for a small family, or control the false discovery rate
   (Benjamini–Hochberg) when the family is large, and say which you used.
5. **Power or sensitivity, not post-hoc power.** Target power, the effect you
   assumed, and the minimum detectable effect given the sample you got.
6. **Report the assumption checks the test rests on** — distribution, equal
   variance, independence, linearity, the proportional-hazards assumption — and
   what you did when one failed.

**Benchmarks for effect sizes.** These are conventions, not thresholds for
importance: the same *d* means different things in different fields, and a
benchmark quoted outside its field is a rhetorical move, not a finding. Report the
raw scale difference alongside the standardised one whenever the scale has meaning
(minutes of sleep, points on a test).

| measure | small | medium | large |
|---|---|---|---|
| Cohen's *d*, Hedges' *g* | 0.2 | 0.5 | 0.8 |
| correlation *r* | .10 | .30 | .50 |
| *η*² (and partial *η*²) | .01 | .06 | .14 |
| Cohen's *f*² | .02 | .15 | .35 |
| Cramér's *V* (df-dependent) | .10 | .30 | .50 |

For an odds ratio, the benchmarks commonly cited are about 1.7, 3.5 and 6.7 for
small, medium and large (Chen, Cohen & Chen, 2010) — and an OR is not a risk
ratio: with a common outcome it exaggerates, so report the risk difference or the
number needed to treat as well when the outcome is not rare.

**Choosing a synthesis model.** A fixed-effect model assumes one true effect; a
random-effects model assumes a distribution of them. Use random effects when
heterogeneity is expected, and know the price: with few studies, τ² is estimated
poorly, so a fixed-effect analysis is worth reporting *as a sensitivity check*
rather than as the headline.

**Heterogeneity.** Report Cochran's *Q* (with its p-value, conventionally tested
at .10 because the test is underpowered), **I²** with its caveat that the bands
overlap and were never meant as thresholds (Cochrane Handbook §10.10.2), τ², and a
prediction interval when there are enough studies — the prediction interval is
what tells a reader what to expect in a *new* setting, which is usually the
question.

**Publication bias**, and its limits: a funnel plot with a test of asymmetry
(Egger's regression, or Peters' for binary outcomes) needs roughly ten studies
before it means anything; trim-and-fill estimates what a symmetric literature
would have looked like; p-curve asks whether the significant results are
evidential or merely selected. With fewer than ten studies, say the bias cannot be
assessed rather than reporting a test that cannot detect it.

**Causal language, in the reported text.** Non-experimental data analysed with
causal vocabulary is one of the most common defects in the literature, and it is a
defect of the *sentence*: fix the verb, not the label. Keep these apart — they are
different claims, not different phrasings.

| not this | this, from observational data | or, from a designed comparison |
|---|---|---|
| "X causes Y" | "X predicts Y", "X is associated with Y" | "X increased Y" (randomised, concealed, blinded) |
| "the effect of X on Y" | "the association between X and Y" | "the effect of X on Y, estimated by …" |
| "X leads to Y" | "X is associated with a higher rate of Y" | — |

Fallacies to check your own draft for, because each one hides in a sentence that
looks careful: **reverse causation** (the outcome caused the exposure), **confounding**
(a third variable explains both), **Simpson's paradox** (the association reverses
within strata), **the ecological fallacy** (group-level data read as individual),
**survivorship bias** (the ones that did not make it into the sample),
**regression to the mean** (extreme groups drift), and **collider bias** (adjusting
for a variable caused by both exposure and outcome).

## 7. Risk of bias, and certainty

A reported association is not a trustworthy one, and the assessment is a
procedure with instruments, not an impression. What was measured matters: risk of
bias is about the *result*, not the report's quality.

| the studies are | the instrument | what it judges in domains |
|---|---|---|
| randomised trials | **RoB 2** | randomisation process; deviations from the intended intervention; missing outcome data; measurement of the outcome; selection of the reported result |
| non-randomised studies of interventions | **ROBINS-I** | confounding; selection of participants; classification of interventions; deviations from intended interventions; missing data; measurement of outcomes; selection of the reported result |
| diagnostic accuracy | **QUADAS-2 / QUADAS-3** | patient selection; index test; reference standard; flow and timing |
| cohort and case-control | **Newcastle–Ottawa** | selection; comparability; outcome or exposure |
| mixed-methods studies | **MMAT** | the qualitative, quantitative and mixed strands, each |

Each domain is judged low / some concerns / high, and the *result* inherits the
worst domain it depends on. Report the judgement per study per domain in a table:
a summary sentence with no table is a judgement nobody can audit.

**Certainty of the body of evidence** is a further step, and **GRADE** is the
usual framework. Start at high for randomised trials, low for observational
studies, then:

- **downgrade** for risk of bias, inconsistency (unexplained heterogeneity),
  indirectness (the wrong population, intervention or outcome), imprecision (an
  interval that crosses a decision threshold, or few events), and publication bias;
- **upgrade** observational evidence only for a large effect, a dose–response
  gradient, or plausible confounding that would have worked *against* the observed
  effect.

Four levels result: high, moderate, low, very low. Say which, and say what did the
downgrading — "moderate certainty, downgraded for imprecision and risk of bias" is
a sentence a decision-maker can act on.

## 8. Systematic reviews, as a process

A systematic review is a study whose data are studies, and it is judged as one.
The process, in order:

1. **A protocol, registered before screening**: question (PICO/PECO), eligibility
   criteria, databases and platforms with planned dates, the search strategy, the
   screening process, the data to extract, the risk-of-bias instrument, the
   synthesis plan, and how certainty will be assessed. Register it — PROSPERO for
   health, OSF for most else, INPLASY, or the review registry your field uses — and
   record the ID in the run's method record as `registration`.
2. **The search**: the exact string per database, with field tags and limits, the
   date of access for each, and any grey-literature sources. A search string that
   cannot be re-run is not reproducible, which is why the method record makes it a
   required field rather than a paragraph.
3. **Deduplication and screening**: two independent screeners at title/abstract,
   then full text, with a recorded reason for every exclusion at full text, and
   adjudication of conflicts by a third party or by discussion. Report agreement
   (percentage, or Cohen's or Fleiss' κ) — not as a quality score, but because a
   reader needs to know how much judgement was involved.
4. **The PRISMA flow**, as numbers: records identified per source, duplicates
   removed, screened, excluded at each stage with reasons, full texts assessed,
   studies included, and — reported separately — the reports of those studies. The
   counts must be internally consistent; this plugin refuses a method record whose
   counts cannot be true.
5. **Data extraction** on a piloted form, by two people where the field expects
   it, with authors contacted for missing data and the attempt recorded.
6. **Risk of bias per study** (§7), then **synthesis**: a meta-analysis only where
   the studies are similar enough in population, intervention, comparator, outcome
   and design to pool — otherwise a structured narrative synthesis, for which
   **SWiM** is the reporting standard. Say why you pooled what you pooled.
7. **Certainty** (GRADE), then **Limitations** naming the search restrictions, the
   language and publication limits, and the bias they carry.

An empty review is a result. "No eligible study was found" is a finding worth
reporting, and a review that quietly converts it into a narrative is the failure
this process exists to prevent.

## 9. Qualitative work

- **Report the guideline**: COREQ for interviews and focus groups, SRQR for a
  wider range of designs. Both ask for the same things: how participants were
  selected, who did the coding, how the themes were derived, and where the
  researcher stands.
- **Sampling** is purposive and driven by the question: maximum variation,
  extreme case, typical case, or theoretical sampling in a grounded-theory study.
  Say which.
- **Coding**: name the approach (inductive, deductive, framework, thematic
  analysis), say whether a codebook was used, whether one person coded or several,
  how disagreements were resolved, and whether coding was done before or after the
  first analysis. Report inter-coder agreement if you claim it, and do not claim
  it if one person did the work.
- **Trustworthiness**, in place of validity and reliability: credibility (member
  checking, triangulation), transferability (thick description), dependability
  (audit trail), confirmability (reflexivity, negative case analysis). Say which
  you did; a methods paragraph that lists them without evidence of doing them is
  the qualitative equivalent of a filled-in CONSORT diagram with no trial under it.
- **Saturation**, stated as evidence (§3) — not as a number.
- **Theme labels with quotes attached**, attributed to a participant identifier and
  not to a name, and quotes that show the range rather than the most quotable.

## 10. Ethics, and who decides

**A plugin cannot make this determination, and neither can an agent.** What
consent, approval and data-protection regime apply is a decision for the
researcher's institution, and the honest move is to collect the facts and route
them to the body that decides.

Collect, for the record:

- **Human participants**: the approving body and its reference number, the consent
  process (written, verbal, waived, and on what basis), what participants were
  told, whether there was deception and how it was debriefed, how withdrawal was
  handled, and what was offered in return.
- **Vulnerable populations**: children, prisoners, people with cognitive
  impairment, patients in a dependent relationship with the researcher,
  undocumented or otherwise criminalised groups. Each adds requirements — assent
  alongside consent, an advocate present, a justification for exclusion as well as
  for inclusion.
- **Data protection**: the lawful basis for processing personal data, what was
  minimised and why, where it is stored, for how long, who can reach it, whether
  it leaves the jurisdiction, and how it is destroyed. Pseudonymisation is not
  anonymisation, and the difference is what a reader's confidence rests on.
- **Secondary data**: whether the original consent covers this use, and what the
  data holder's terms permit. An ethics exemption for the original study is not one
  for yours.
- **Animals**: the 3Rs (replacement, reduction, refinement), the approving body,
  and the ARRIVE checklist at report time.
- **Dual use and misuse**: whether the finding could be used to cause harm, and
  whether that needs handling rather than publication.
- **Conflict of interest**: financial and non-financial, for every author, declared
  even when it feels irrelevant — the reader decides relevance, not the author.
- **AI use**: whether and how generative tools were used, per the venue's policy.
  An AI system cannot be an author, cannot take responsibility, and cannot consent
  to be one — every policy surveyed says so.

Say plainly in the document which approvals were obtained and by whom. "Ethics
approval was obtained" with no body and no number is a sentence a reader cannot
check.

## 11. Authorship, contributions, funding

- **ICMJE's four criteria**, all of which must hold for authorship: substantial
  contribution to conception/design or acquisition/analysis/interpretation; drafting
  or critically revising; final approval of the version published; and agreement to
  be accountable for all of it. A contributor who meets none is acknowledged, not
  listed; one who meets all four cannot be dropped for convenience.
- **CRediT** names the contributions: conceptualization; methodology; software;
  validation; formal analysis; investigation; resources; data curation; writing —
  original draft; writing — review and editing; visualization; supervision;
  project administration; funding acquisition. Record them per author; a
  contribution statement is the honest answer to "who did what".
- **Corresponding author** is an administrative role, not a seniority marker, and
  author order conventions differ by field — check the venue's guidance rather than
  importing another field's.
- **Funding**: every source, with the grant number, plus what the funder had no
  role in (design, analysis, publication) when that is true. An undisclosed funder
  is the finding a reader will not forgive.
- **Data availability**: where the data are, under what access conditions, and why
  if they cannot be shared. "Available on request" is a statement a reader is
  entitled to read as "not available".

## 12. Preregistration

Preregister when the study is confirmatory: a trial (ClinicalTrials.gov or the
registry your jurisdiction requires, before the first participant), a systematic
review (PROSPERO, OSF, INPLASY), or any study whose hypothesis you want a reader to
know preceded the data. Confirmatory work that is not preregistered is not
worthless — it is simply weaker evidence, and saying so is better than implying
otherwise.

What to register, and it is not the whole paper:

- the **hypotheses**, and which is primary;
- the **primary outcome** and its measurement, with the time point;
- the **sample size** and its rationale;
- the **analysis plan**: the model, the covariates, the subgroups, the stopping
  rule, and how missing data will be handled;
- the **exclusions**, decided in advance rather than after looking.

For exploratory work, preregistration is the wrong instrument — say the analysis
is exploratory, and treat the result as a hypothesis for the next study. What is
never acceptable is the analysis plan written after the results: the deviations
from a registered plan are reportable, and naming them costs a paragraph.

## 13. Before the document leaves the run

A method checklist that fits on one screen:

- [ ] the question is one sentence and falsifiable, and it is in `plan/rq.md`;
- [ ] the design is named, and every claim's `strength` is one it can carry;
- [ ] the method record exists: databases, date of access, search string, criteria,
      screening counts — and `identified >= screened >= included`;
- [ ] every claim that rests on a number has a `statistic`, with an effect size and
      an interval, and no `p = .000`;
- [ ] the sample size has a justification, and a null result comes with the
      minimum detectable effect;
- [ ] missing data: amount, mechanism, method, and a sensitivity check;
- [ ] multiplicity is stated and corrected, or stated as not applicable;
- [ ] the reporting guideline for the design is named, and every unmet item is in
      Limitations;
- [ ] risk of bias is judged per study per domain, and certainty is stated with
      the reasons for any downgrade;
- [ ] ethics, consent, data availability, funding, conflicts and contributions are
      all stated;
- [ ] AI use is disclosed per the venue's policy;
- [ ] preregistration ID recorded, or the absence explained;
- [ ] the data and code (or the reason they cannot be shared) are where the
      document says they are.

## What this reference is not

- **Not a substitute for a statistician.** The formulas, thresholds and
  instruments here are the standards a reader will hold the work to; applying them
  is the author's job.
- **Not a source of values.** Where a number matters (a cut-off, a minimal
  clinically important difference, a benchmark), cite the source you took it from.
  A benchmark with no citation is a preference.
- **Not complete.** New guidelines appear and old ones are revised; the version of
  a checklist matters, and the version a document claims to follow should be
  written down.
- **Not a licence to overstate.** Everything in this file exists to make a claim
  smaller and more checkable, never to make a document sound more rigorous than
  the work behind it.
