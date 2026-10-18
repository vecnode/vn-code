#!/usr/bin/env node
/**
 * vendor/impeccable/build-engine.mjs — the detector, built HERE from the pin.
 *
 * The rules are Impeccable's Rust `crates/core` + `foundation`, compiled by the
 * user's own toolchain to one WebAssembly module. This is what "no download"
 * means for the second half of the vendoring: the bytes in `lib/vendor/
 * impeccable/detect/` were produced by the commands below, on a normal machine
 * with Rust installed, from the same commit the corpus comes from.
 *
 *   rustup target add wasm32-unknown-unknown
 *   cargo build --release -p impeccable-wasm --target wasm32-unknown-unknown --features detect
 *   wasm-bindgen --target nodejs --out-dir <tmp> --out-name detect <the .wasm>
 *
 * Measured on 2026-10-18: 54 s cold, 4,558,054 bytes of wasm + 64.9 KB of glue.
 * `--target nodejs` is deliberate: the host loads it through `createRequire`,
 * which is the one loader the ESM host half and the classic-script client can
 * both use without a bundler. The tab never loads the wasm itself; it asks the
 * host over a route, so the module exists once per session, not once per tab.
 *
 * Usage:
 *   node vendor/impeccable/build-engine.mjs --source <checkout> [--wasm-bindgen <path>]
 *   node vendor/impeccable/build-engine.mjs --from <generated-dir>   # copy a build you trust
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..', '..')
const outDir = path.join(packageRoot, 'lib', 'vendor', 'impeccable', 'detect')
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function copyArtifacts(from) {
  // The glue is CommonJS while this package is ESM (`"type": "module"`), so it
  // lands as `.cjs`; `require()` of a `.js` file inside an ESM package is parsed
  // as ESM and dies on `exports`. The wasm's own name is what the glue looks up.
  mkdirSync(outDir, { recursive: true })
  const pairs = [
    ['detect.js', 'detect.cjs'],
    ['detect_bg.wasm', 'detect_bg.wasm'],
  ]
  for (const [name, target] of pairs) {
    const file = path.join(from, name)
    if (!existsSync(file)) {
      console.error('build-engine: no ' + name + ' in ' + from)
      process.exit(1)
    }
    copyFileSync(file, path.join(outDir, target))
  }
  const wasm = statSync(path.join(outDir, 'detect_bg.wasm'))
  console.log('build-engine: detect_bg.wasm ' + wasm.size + ' bytes, detect.cjs ' + statSync(path.join(outDir, 'detect.cjs')).size + ' bytes')
}

const from = flag('--from')
if (from) {
  copyArtifacts(path.resolve(from))
} else {
  const source = flag('--source')
  if (!source) {
    console.error('build-engine: --source <impeccable checkout> (or --from <dir with detect.js and detect_bg.wasm>)')
    process.exit(1)
  }
  const checkout = path.resolve(source)
  const wasmBindgen = flag('--wasm-bindgen') ?? process.env.WASM_BINDGEN
  if (!wasmBindgen || !existsSync(wasmBindgen)) {
    console.error('build-engine: --wasm-bindgen <path to wasm-bindgen> (version 0.2.127) or WASM_BINDGEN=...')
    process.exit(1)
  }
  // The crate compiles with the checkout's own toolchain; nothing is fetched.
  execFileSync('cargo', ['build', '--release', '-p', 'impeccable-wasm', '--target', 'wasm32-unknown-unknown', '--features', 'detect'], {
    cwd: checkout,
    stdio: 'inherit',
  })
  const built = path.join(checkout, 'target', 'wasm32-unknown-unknown', 'release', 'impeccable_wasm.wasm')
  if (!existsSync(built)) {
    console.error('build-engine: cargo produced no ' + built)
    process.exit(1)
  }
  const tmp = path.join(here, '.cache', 'wasm-out')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execFileSync(wasmBindgen, ['--target', 'nodejs', '--out-dir', tmp, '--out-name', 'detect', built], { stdio: 'inherit' })
  copyArtifacts(tmp)
}
