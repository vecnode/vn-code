# Academic presentations - the checks a deck is built against

Distilled from David Hirshleifer's *Best Practices for Academic Presentations*
(28 Feb 2026, built with Claude), vendored beside this file as
`academic-presentation-best-practices.pdf` from
<https://github.com/Gabberflast/academic-pptx-skill> (MIT). Read the PDF for the
full argument; this page is the checklist `deck_run` batches are written against.

Use it for conference talks, seminar slides, thesis defences and grant briefings.
For a product deck the same rules mostly hold, but the argument format below is
the academic one.

## The argument comes before the design

The hierarchy is **argument structure > data > layout > aesthetics**. A visually
plain deck with a clear argument beats a beautiful deck with none, and that is
the order to fix things in: if the argument is wrong, no theme saves it.

- Decide the presentation **type** first: structured argument (the academic
  default), or narrative/visual (public engagement, non-specialist funding
  pitch). The type decides how much framing the audience needs.
- **One central claim** for the whole deck. Researchers try to present the whole
  paper; resist it. Choose the part the time can carry.
- State the claim or question in the **first two or three slides**.
- Give every slide **one job**. A slide doing two things is two slides.
- Narrative spine: *Situation -> Complication -> Resolution*, or *context ->
  gap -> approach -> findings -> implications*.
- Each slide should make the next feel like a consequence.

## Titles are sentences

The single highest-impact rule: **every slide title states the takeaway**, not a
topic.

```text
WRONG: "Results"                       RIGHT: "Treatment effect holds in all three cohorts"
WRONG: "Literature Review"             RIGHT: "Prior work leaves the mechanism unexplained"
WRONG: "Methods"                       RIGHT: "Difference-in-differences on 12 quarters of filings"
```

- One or two lines. Longer means the point is not sharp yet.
- **Ghost deck test**: read only the titles in order. They must tell the whole
  argument. If they do not, repair the logic before touching the design.

## One exhibit, one insight

- One chart, table, diagram or equation per slide, and it must support that
  slide's action title. If it does not, change the title or the exhibit.
- **Self-sufficient slide test**: the key point must be clear to someone who
  cannot hear the narration. Add a call-out, an annotation box, or highlight the
  data point.
- Prefer **graphs over tables** for results; tables are hard to parse under time
  pressure.
- Figure left, explanatory text right (reading direction).
- Mark the finding **on the chart** - arrow, colour, annotation - do not make the
  audience find it.
- No decorative icons, stock images or clip art. If a visual carries no
  analytical content, it is noise.
- Do not paste figures from the paper: rebuild them at projection resolution.
- Only include an exhibit you will explicitly discuss.

## Text is not a document

- Complete sentences belong in **titles only**; body text is short parallel
  bullets, one idea each.
- **~40 words of body text per slide, maximum.** Detail goes to the appendix.
- One sans-serif typeface throughout. Body >= 20pt, titles 24-28pt, citations and
  footnotes ~14pt.
- Slides may drop articles and filler: `Intervention reduced costs by 23%
  (p < 0.01)` beats `Our study found that the intervention reduced costs.`
- Bold and italic for key terms, never for decoration.

## Design that gets out of the way

- At most **three colours**: one primary, one accent, one for emphasis/alerts.
  Academic default: white background, dark grey text, one accent. No decorative
  gradients.
- One typeface; hierarchy comes from weight and size.
- Left-align body text; centre only titles and axis labels. One grid, one margin.
- White space is **analytical signal**: a dense slide reads as unclear thinking.
- 16:9 for screen presentations; confirm the venue's aspect ratio.

## Citations (academic-specific)

- Cite every claim, figure and exhibit that is not your own work. Academic
  integrity applies to slides exactly as to papers; an uncited borrowed figure is
  a plagiarism risk.
- In-text citations in the field's format - (Author, Year) for sciences/social
  sciences, footnotes/superscripts for humanities - at the **bottom of the slide,
  ~14pt**.
- A **References slide** at the end with full citations for everything cited.
- A reproduced figure carries an attribution caption beneath it *and* a full
  reference. Publisher permission is often required; conference use is usually
  fair use, but check.
- Say the source before showing it: "Smith et al. (2022) showed..." rather than a
  silent parenthetical.

## Deck architecture for an academic talk

| Slide | What it must do |
|---|---|
| Title | full title as a statement or question; authors, affiliations, venue, date |
| Motivation / context | why the problem matters; the real gap in the literature |
| Research question / hypothesis | stated precisely and early |
| Methods (1-2 slides) | only what the audience needs to evaluate the findings; the rest is appendix |
| Results | one finding per slide; figures over tables; the result marked on the chart |
| Discussion / implications | interpret, state limitations, connect back to the question |
| Conclusions | one slide, the 2-3 takeaways - **stay on screen during Q&A** |
| References | full citations |
| Appendix | pre-built answers to likely questions, method detail, sensitivity analyses |

Do not end on "Thank You" or a blank slide: the conclusions slide is what the
audience anchors questions to.

## Timing and delivery

- **One slide per minute, maximum.** A 15-minute slot is 12-14 content slides
  (excluding title and references).
- Practise out loud to time, aiming to finish 1-2 minutes under: nerves speed
  delivery up, and going over is a professional misstep at a conference.
- Practise to a specialist *and* a non-specialist; the second reveals where the
  argument loses the room.
- Pre-build appendix slides for the 3-5 most likely questions.
- Invite "questions or feedback", not only questions.
- Contact details, and a QR code or short URL to the slides/preprint, on the
  final slide.
- Two formats and two locations for the file; test on the venue hardware.

## The common mistakes, as a final pass

1. Topic labels as titles.
2. Presenting the whole paper.
3. Reading the paper aloud.
4. Evidence with no "so what".
5. Uncited borrowed figures or data.
6. Dense slides, small text.
7. Inconsistent formatting, mixed fonts, mixed citation styles.
8. Unreferenced content - if you will not discuss it, remove it.
9. Going over time.
10. Burying the research question.
11. Ending on a blank or "Thank You" slide.
