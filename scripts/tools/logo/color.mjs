// WCAG 2.x relative luminance, the same formula vn-ranger's BRAND.md quotes. One copy,
// because the sheet prints these ratios and MANIFEST.toml records them: a hand-typed
// number would be a claim, and a computed one is a measurement.

export const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

export const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

// The sheet prints "6.44:1"; MANIFEST.toml records the same string.
export const asRatio = (value) => value.toFixed(2) + ':1'
