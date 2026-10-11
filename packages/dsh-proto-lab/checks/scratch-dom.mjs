import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const lab = await import('../lib/lab.js')
const { runtimeOf } = await import('../lib/runtimes/index.js')
const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dpl-dom-')))
const p5 = runtimeOf('p5js')
const made = await lab.scaffoldRun({ root, runtime: p5, slug: 'domprobe', concept: 'probe', seed: 5, params: p5.defaultParams(), env: { ...process.env, DSH_PROTO_LAB_ROOT: root } })
const ex = (await p5.examples())[0]
const inst = await lab.instantiateExample({ root, runtime: p5, example: ex, slug: 'exprobe' })
await fsp.writeFile(path.join(os.tmpdir(), 'dpl-run-path.txt'), made.run.dir)
await fsp.writeFile(path.join(os.tmpdir(), 'dpl-ex-path.txt'), inst.run.dir)
console.log('RUN=' + made.run.dir)