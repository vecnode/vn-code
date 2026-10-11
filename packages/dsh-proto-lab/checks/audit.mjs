import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const lab = await import('../lib/lab.js')
const { runtimeOf } = await import('../lib/runtimes/index.js')
const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dpl-audit-')))
const env = { ...process.env, DSH_PROTO_LAB_ROOT: root }
const p5 = runtimeOf('p5js')
const made = await lab.scaffoldRun({ root, runtime: p5, slug: 'audit', concept: 'audit', seed: 4242, params: p5.defaultParams({ scale: 1 }), env })
const ex = (await p5.examples())[0]
const inst = await lab.instantiateExample({ root, runtime: p5, example: ex, slug: 'auditex' })
const template = await fsp.readFile(path.join(made.run.dir, 'sketch.js'), 'utf8')
const example = await fsp.readFile(path.join(inst.run.dir, 'sketch.js'), 'utf8')
// Print just the lines that touch the lifecycle and the first draw, side by side.
const show = (label, text) => {
  console.log('=== ' + label + ' ===')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (/__dshProtoLabLifecycle__|randomSeed|noiseSeed|if \(dirty\)|state\.frames|spec\.drew|first === true|window\.labOnParam|^}/.test(lines[i])) {
      console.log(String(i + 1).padStart(4) + ': ' + lines[i].trim())
    }
  }
}
show('template', template)
show('example ' + ex.slug, example)
await fsp.writeFile(path.join(process.env.TEMP, 'dpl-audit-path.txt'), made.run.dir + '\n' + inst.run.dir)
console.log('kept: ' + root)