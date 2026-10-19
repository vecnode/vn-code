// The suite mark, parameterised by inlay colour.
//
// Geometry is vn-ranger's, digit for digit: the suite rule is that a new application
// changes the inlay and nothing else. Every path below is copied from
// vn-ranger/assets/logo/vn-ranger.svg, so vn-code's crystal cannot drift from the rest
// of the vecnode/vn suite. Change a coordinate here and every rendered size, the
// application tile and the brand sheet follow.

export const GEOMETRY = {
  hex: 'M12 2.8 L20.8 7.4 L20.8 16.6 L12 21.2 L3.2 16.6 L3.2 7.4 Z',
  crown: 'M3.2 7.4 L12 12 L20.8 7.4',
  spineTop: 'M12 2.8 L12 12',
  spineBottom: 'M12 12 L12 21.2',
  girdleLeft: 'M12 15.4 L3.2 16.6',
  girdleRight: 'M12 15.4 L20.8 16.6',
  stroke: 2.914,
}

// The application tile, in the 1024-unit space of vn-ranger-app.svg.
export const TILE = { px: 1024, radius: 308, scale: 22.73, translate: 239.25 }

export const INK = '#0B0D10'
export const PAPER = '#FFFFFF'
export const MUTED = '#9AA1AC'

// Jade: ember's tonal ladder with the hue rotated to green. The crown and the base were
// solved so that every pair in vn-ranger's BRAND.md lands on the same contrast ratio in
// green - in particular white on the crown stays at ember's 1.96:1 instead of falling
// to 1.51:1 with a brighter mint, which would let the application tile's white ridges
// melt into the top facets.
export const JADE = { name: 'jade', highlight: '#74CAA3', core: '#1FA96B', deep: '#198856' }

export const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

const gradient = (palette) => `<defs>
    <linearGradient id="inlay" x1="12" y1="2.8" x2="12" y2="21.2" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${palette.highlight}"/>
      <stop offset="0.55" stop-color="${palette.core}"/>
      <stop offset="1" stop-color="${palette.deep}"/>
    </linearGradient>
  </defs>`

// The crystal itself, at the 24-unit grid. `ridge` is the linework colour; the inlay is
// one hexagon fill BENEATH the linework, so the facets read as one crystal.
const crystal = (ridge, indent = '') =>
  [
    `<path d="${GEOMETRY.hex}" fill="url(#inlay)"/>`,
    `<g fill="none" stroke="${ridge}" stroke-width="${GEOMETRY.stroke}" stroke-linecap="round" stroke-linejoin="round">`,
    `  <path d="${GEOMETRY.hex}"/>`,
    `  <path d="${GEOMETRY.crown}"/>`,
    `  <path d="${GEOMETRY.spineBottom}"/>`,
    `  <path d="${GEOMETRY.spineTop}"/>`,
    `  <path d="${GEOMETRY.girdleLeft}"/>`,
    `  <path d="${GEOMETRY.girdleRight}"/>`,
    `</g>`,
  ]
    .map((line) => indent + line)
    .join('\n')

export const lightSvg = (palette, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512" role="img" aria-label="${label}">
  ${gradient(palette)}
${crystal(INK)}
</svg>
`

export const whiteSvg = (palette, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512" role="img" aria-label="${label}">
  ${gradient(palette)}
${crystal(PAPER)}
</svg>
`

// The application icon: the same crystal on the suite's ink tile, scaled into the tile's
// clear space and drawn with white ridges, which is what holds on a dark taskbar.
export const appSvg = (palette, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE.px} ${TILE.px}" width="${TILE.px}" height="${TILE.px}" role="img" aria-label="${label}">
  ${gradient(palette)}
  <rect width="${TILE.px}" height="${TILE.px}" rx="${TILE.radius}" fill="${INK}"/>
  <g transform="translate(${TILE.translate} ${TILE.translate}) scale(${TILE.scale})">
${crystal(PAPER, '    ')}
  </g>
</svg>
`
