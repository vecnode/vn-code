/**
 * dsh-proto-lab — the checks' own PNG reader, so a render can be MEASURED.
 *
 * Why this exists, and why the obvious way does not work. A check that measures a
 * p5.js run wants to know what the run drew - how many colours, how much of the
 * frame is not background, whether two seeds differ. The obvious source is the
 * canvas's own 2D context (`getImageData`), and in a headless browser it LIES:
 * measured against a generated run that Chrome's own screenshot shows is full of
 * colour (994 distinct colours, #840000 particles over a black field),
 * `getImageData` returned a uniform 365 356-pixel black - every pixel. The drawing
 * is real; the readback path through an accelerated canvas is what is broken.
 *
 * So the measurement uses the browser's own encoder instead: `Page.captureScreenshot`
 * over CDP, decoded here. That is also the more honest measurement - it is the
 * picture a person would see, after layout and CSS, rather than the state of one
 * context - and it compares two seeds for free.
 *
 * WHAT IT DECODES
 *
 * A PNG from a browser screenshot, which is a narrow format: 8-bit, no
 * interlacing, and one of the three colour types a screen encoder produces (2 =
 * truecolour, 6 = truecolour with alpha, 0 = greyscale). Filters are undone per
 * scanline as the specification defines them. Everything else is refused with a
 * sentence rather than decoded wrongly - a check that mis-reads a picture is worse
 * than one that says it cannot read it.
 *
 * No dependency, deliberately: this is ~120 lines of Node and the pack ships zero
 * npm packages.
 */

import { inflateSync } from 'node:zlib'

/** The signature every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** How many bytes one pixel takes for a colour type. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * Decode a PNG into raw RGBA pixels.
 *
 * @param buffer - the file's bytes.
 * @returns `{ width, height, pixels: Buffer }` - RGBA, 4 bytes per pixel.
 * @throws Error with a readable reason for anything this reader refuses.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (the signature is missing)')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colourType = 6
  let interlace = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colourType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width === 0 || height === 0) throw new Error('the PNG has no IHDR dimensions')
  if (bitDepth !== 8) throw new Error('only an 8-bit PNG is read (this one is ' + bitDepth + '-bit)')
  if (interlace !== 0) throw new Error('an interlaced PNG is not read')
  const channels = CHANNELS[colourType]
  if (channels === undefined) throw new Error('colour type ' + colourType + ' is not one a screenshot produces')
  if (idat.length === 0) throw new Error('the PNG carries no image data')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('the PNG image data is short (' + raw.length + ' bytes for ' + width + 'x' + height + ')')

  // Undo the per-scanline filters exactly as the specification defines them: each
  // line is prefixed by its filter type and the line before it is the reference.
  const pixels = Buffer.alloc(width * height * 4)
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    raw.copy(current, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      if (filter === 1) current[index] = (current[index] + left) & 0xff
      else if (filter === 2) current[index] = (current[index] + up) & 0xff
      else if (filter === 3) current[index] = (current[index] + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const distanceLeft = Math.abs(estimate - left)
        const distanceUp = Math.abs(estimate - up)
        const distanceUpLeft = Math.abs(estimate - upLeft)
        const predictor = distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft
        current[index] = (current[index] + predictor) & 0xff
      } else if (filter !== 0) {
        throw new Error('scanline ' + y + ' has filter type ' + filter + ', which is not defined')
      }
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      if (colourType === 2) {
        pixels[to] = current[from]
        pixels[to + 1] = current[from + 1]
        pixels[to + 2] = current[from + 2]
        pixels[to + 3] = 255
      } else if (colourType === 6) {
        pixels[to] = current[from]
        pixels[to + 1] = current[from + 1]
        pixels[to + 2] = current[from + 2]
        pixels[to + 3] = current[from + 3]
      } else if (colourType === 0) {
        pixels[to] = current[from]
        pixels[to + 1] = current[from]
        pixels[to + 2] = current[from]
        pixels[to + 3] = 255
      } else {
        pixels[to] = current[from]
        pixels[to + 1] = current[from]
        pixels[to + 2] = current[from]
        pixels[to + 3] = current[from + 1]
      }
    }
    current.copy(previous)
  }
  return { width, height, pixels }
}

/**
 * What a picture is, as numbers.
 *
 * Two of them are the verdict: `background` is the share of pixels that hold the
 * most common colour (a blank frame is 1, a drawn one is well under it), and
 * `signature` changes when the picture does - which is exactly what "a different
 * seed draws a different picture" needs, and why the same seed must reproduce it.
 *
 * @param buffer - PNG bytes.
 * @returns `{ width, height, colours, background, signature, ink }`.
 */
export function measurePng(buffer) {
  const { width, height, pixels } = decodePng(buffer)
  const counts = new Map()
  let hash = 2166136261
  for (let at = 0; at < pixels.length; at += 4) {
    const key = (pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
    hash = (hash ^ key) >>> 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  let common = 0
  for (const count of counts.values()) common = Math.max(common, count)
  const total = width * height
  return {
    width,
    height,
    colours: counts.size,
    background: Number((common / total).toFixed(4)),
    ink: Number(((total - common) / total).toFixed(4)),
    signature: hash.toString(16),
  }
}
