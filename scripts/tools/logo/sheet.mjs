// The brand sheet: 1600 x 1000, laid out to vn-ranger's contact sheet. Every coordinate
// below was measured off that sheet (card edges, the mark's 206 x 214 visible bounds, the
// ladder's own centres), so the two read as one family rather than as two designs.
//
// The type is the system UI face. vn-ranger's sheet is set in Inter, which it vendors;
// vn-code does not, and vendoring 830 KB of font to draw one sheet would make this
// repository carry a third-party asset for a caption. Segoe UI / SF / DejaVu italicise
// nothing and widen the headings slightly - that is the whole difference.

import { appSvg, lightSvg, whiteSvg } from './marks.mjs'
import { asRatio, contrast } from './color.mjs'

export const SHEET = { width: 1600, height: 1000 }

const FONT = `'Inter','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif`

const INK = '#0B0D10'
const CARD_DARK = '#12161C'
const CARD_APP = '#2E3138'
const MUTED = '#9AA1AC'
const PAPER = '#FFFFFF'

// Measured off the reference sheet: the ladder's centres, a common centre line for the
// marks, and one baseline for the numbers beneath them.
const LADDER = [
  { size: 16, x: 68 },
  { size: 24, x: 164 },
  { size: 32, x: 260 },
  { size: 48, x: 360 },
  { size: 64, x: 460 },
  { size: 96, x: 568 },
  { size: 128, x: 706 },
]
const LADDER_Y = 664
const LABEL_Y = 730

const at = (left, top, extra = '') => `position:absolute;left:${left}px;top:${top}px;${extra}`

// Inline the SVG at the size it is shown, so the browser rasterises it once, at that size.
const inline = (svg, size) =>
  svg
    .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
    .replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)

const swatch = (top, fill, name, hex, ring = '') => `
  <div style="${at(1220, top)};width:40px;height:40px;border-radius:8px;background:${fill};${
    ring ? `box-shadow:inset 0 0 0 1px ${ring};` : ''
  }"></div>
  <div style="${at(1276, top + 3)};font-size:13px;font-weight:600;color:${PAPER}">${name}</div>
  <div style="${at(1276, top + 21)};font-size:12px;color:${MUTED};letter-spacing:0.02em">${hex}</div>`

const contrastRow = (top, label, ratio, accent = false) => `
  <div style="${at(1220, top)};font-size:13px;color:${accent ? 'var(--accent)' : MUTED}">${label}</div>
  <div style="${at(1330, top)};font-size:13px;color:${accent ? 'var(--accent)' : MUTED}">${ratio}</div>`

export function sheetHtml(brand) {
  const whiteOnCore = contrast(PAPER, brand.core)

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { margin: 0 }
  html,body { margin:0; padding:0; width:${SHEET.width}px; height:${SHEET.height}px; overflow:hidden;
    background:${INK}; font-family:${FONT}; color:${PAPER};
    -webkit-font-smoothing:antialiased; font-kerning:normal }
  :root { --accent:${brand.core} }
  div { box-sizing:border-box }
</style></head><body>
  <!-- header -->
  <div style="${at(60, 56)};font-size:44px;font-weight:700;letter-spacing:-0.025em;color:${PAPER}">${brand.name}</div>
  <div style="${at(60, 111)};font-size:19px;font-weight:400;color:${MUTED}">${brand.tagline}</div>
  <div style="${at(0, 74)};left:auto;right:60px;font-size:13px;letter-spacing:0.09em;color:${MUTED}">${brand.markline}</div>

  <!-- the three surfaces: 340 x 340 cards, the mark at vn-ranger's 241-unit box -->
  <div style="${at(60, 170)};width:340px;height:340px;border-radius:16px;background:${PAPER}">
    <div style="${at(37, 37)}">${inline(lightSvg(brand, brand.name), 241)}</div>
    <div style="${at(19, 292)};font-size:16px;font-weight:600;line-height:1;color:${INK}">Light</div>
    <div style="${at(19, 313)};font-size:12px;line-height:1;color:#7C838D">${brand.slug}.svg</div>
  </div>

  <div style="${at(440, 170)};width:340px;height:340px;border-radius:16px;background:${CARD_DARK}">
    <div style="${at(37, 37)}">${inline(whiteSvg(brand, brand.name), 241)}</div>
    <div style="${at(19, 292)};font-size:16px;font-weight:600;line-height:1;color:${PAPER}">Dark</div>
    <div style="${at(19, 313)};font-size:12px;line-height:1;color:${MUTED}">${brand.slug}-white.svg</div>
  </div>

  <div style="${at(820, 170)};width:340px;height:340px;border-radius:16px;background:${CARD_APP}">
    <div style="${at(52, 38)}">${inline(appSvg(brand, brand.name), 236)}</div>
    <div style="${at(19, 292)};font-size:16px;font-weight:600;line-height:1;color:${PAPER}">Application</div>
    <div style="${at(19, 313)};font-size:12px;line-height:1;color:${MUTED}">${brand.slug}-app.svg</div>
  </div>

  <!-- palette -->
  <div style="${at(1220, 170)};font-size:19px;font-weight:600;color:${PAPER}">Palette</div>
  ${swatch(213, brand.core, brand.swatch, brand.core)}
  ${swatch(266, brand.highlight, 'Highlight', brand.highlight)}
  ${swatch(319, brand.deep, 'Deep', brand.deep)}
  ${swatch(372, INK, 'Ink', INK, '#FFFFFF14')}
  ${swatch(425, PAPER, 'Paper', PAPER)}

  <!-- contrast, measured, not typed -->
  <div style="${at(1220, 511)};font-size:19px;font-weight:600;color:${PAPER}">Contrast</div>
  ${contrastRow(543, `${brand.swatch} on Ink`, asRatio(contrast(brand.core, INK)))}
  ${contrastRow(567, `Ink on ${brand.swatch}`, asRatio(contrast(INK, brand.core)))}
  ${contrastRow(591, `White on ${brand.swatch}`, asRatio(whiteOnCore) + '*')}
  ${contrastRow(619, '*  large text and icons only', '', true)}

  <!-- sizes, each rendered at its exact size -->
  <div style="${at(60, 537)};font-size:19px;font-weight:600;color:${PAPER}">Sizes</div>
  <div style="${at(60, 561)};font-size:13px;color:${MUTED}">Rendered at exact size, not downscaled.</div>
  ${LADDER.map(
    ({ size, x }) => `
    <div style="${at(x - size / 2, LADDER_Y - size / 2)}">${inline(lightSvg(brand, brand.name), size)}</div>
    <div style="${at(x - 30, LABEL_Y)};width:60px;text-align:center;font-size:12px;color:${MUTED}">${size}</div>`,
  ).join('')}

  <!-- the rules -->
  <div style="${at(57, 770)};width:1486px;height:118px;border-radius:12px;background:${CARD_DARK};padding:26px 0 0 27px">
    <div style="font-size:19px;color:${PAPER};letter-spacing:-0.005em">${brand.notes.rule}</div>
    <div style="margin-top:11px;font-size:15px;color:${MUTED}">${brand.notes.never}</div>
    <div style="margin-top:7px;font-size:15px;color:${MUTED}">${brand.notes.textPair}</div>
  </div>

  <!-- footer -->
  <div style="${at(60, 938)};font-size:13px;color:${MUTED}">${brand.footer}</div>
  <div style="${at(0, 936)};left:auto;right:60px;font-size:15px;font-weight:500;color:var(--accent)">${brand.name}</div>
</body></html>
`
}
