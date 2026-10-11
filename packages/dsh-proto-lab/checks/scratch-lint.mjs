import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const lab = await import('../lib/lab.js')
const { runtimeOf } = await import('../lib/runtimes/index.js')
const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dpl-lint-')))
const env = { ...process.env, DSH_PROTO_LAB_ROOT: root }
const p5 = runtimeOf('p5js')
const made = await lab.scaffoldRun({ root, runtime: p5, slug: 'lintprobe', concept: 'probe', seed: 5, params: p5.defaultParams(), env })
const catalog = (await lab.readCatalog(root)).catalog
const report = await lab.lintRun({ root, runtime: p5, run: made.run.id, catalog, env })
console.log(JSON.stringify(report.issues, null, 1))
await fsp.rm(root, { recursive: true, force: true })