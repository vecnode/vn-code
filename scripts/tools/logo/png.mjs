// A PNG reader for what Chrome writes: 8-bit, non-interlaced, grey / RGB / RGBA.
// It exists so the renderer can prove the file it just wrote is the size it asked for
// and that a bare mark's corners are still transparent - and so a shifted pixel cannot
// ship unnoticed.

import { inflateSync } from 'node:zlib'

export function readHeader(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType: buffer[25],
    interlace: buffer[28],
  }
}

export function decodePng(buffer) {
  const header = readHeader(buffer)
  if (header.bitDepth !== 8) throw new Error(`bit depth ${header.bitDepth} is not 8`)
  if (header.interlace !== 0) throw new Error('interlaced PNGs are not supported')
  const channels = header.colourType === 6 ? 4 : header.colourType === 2 ? 3 : header.colourType === 0 ? 1 : 0
  if (channels === 0) throw new Error(`colour type ${header.colourType} is not supported`)

  const idat = []
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }

  const { width, height } = header
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    const line = Buffer.from(raw.subarray(cursor + 1, cursor + 1 + stride))
    cursor += 1 + stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      line[x] = value & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      if (channels >= 3) {
        out[at] = line[x * channels]
        out[at + 1] = line[x * channels + 1]
        out[at + 2] = line[x * channels + 2]
        out[at + 3] = channels === 4 ? line[x * channels + 3] : 255
      } else {
        out[at] = out[at + 1] = out[at + 2] = line[x]
        out[at + 3] = 255
      }
    }
    previous = line
  }
  return { ...header, data: out }
}

export const pixelAt = (png, x, y) => {
  const i = (y * png.width + x) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]
}
