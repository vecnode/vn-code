import { readFileSync } from 'node:fs'
import { measurePng } from './png.mjs'
const measure = measurePng(readFileSync(process.env.TEMP + '\\dpl-shot.png'))
console.log(JSON.stringify(measure, null, 1))