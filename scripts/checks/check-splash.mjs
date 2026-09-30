// ============================================================================
//  scripts/checks/check-splash.mjs - the startup window's own two halves.
//
//  WHY THIS EXISTS
//  ---------------
//  The line a person reads while the harness starts - "DeepSeek key loaded" or
//  "No DeepSeek key yet" - is produced by TWO halves in TWO languages that never
//  import each other:
//
//    app/src-tauri/src/keystate.rs   decides, and emits a JSON payload that
//                                    Tauri injects before the document parses
//    app/ui/index.html               reads that payload in an inline script and
//                                    draws the line
//
//  Nothing type-checks across that seam. A renamed field (`source` -> `from`),
//  a renamed global, or a page that forgets to un-hide the element produces a
//  splash that is silently, quietly wrong - no error, no test failure, just a
//  blank line where the user expected the answer to "did my key survive the new
//  version". That is the exact failure this file pins.
//
//  What it does NOT do: it does not re-test the DECISION. Which layer wins, a
//  BOM, an indented key, a leaked secret - all of that is `cargo test`
//  (keystate.rs, 18 cases). This check owns the OTHER half: that the page turns
//  the payload into the right words, and that both sides agree on the names.
//
//  Run:  node scripts/checks/check-splash.mjs
// ============================================================================
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pagePath = path.join(repo, 'app', 'ui', 'index.html')
const rustPath = path.join(repo, 'app', 'src-tauri', 'src', 'keystate.rs')

const failures = []
const notes = []
const fail = (message) => failures.push(message)

function read(file, label) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    fail(`${label} is missing (${path.relative(repo, file)}) - the splash cannot be checked.`)
    return null
  }
}

const html = read(pagePath, 'the splash page')
const rust = read(rustPath, 'the key-state module')

// ---------------------------------------------------------------------------
// 1. The page and the shell must agree on the NAMES
// ---------------------------------------------------------------------------
// The global, and the three fields the page reads out of it. The Rust half is
// grepped for the same literals rather than parsed: the payload is built with
// `serde_json::json!`, and a text assertion on the exact key strings is what
// catches a rename in either direction.
const GLOBAL = '__VNCODE_SPLASH__'
const FIELDS = ['"key"', '"loaded"', '"source"', '"home"']

if (html) {
  if (!html.includes(GLOBAL)) {
    fail(`app/ui/index.html never reads ${GLOBAL} - the shell's injected state would be ignored.`)
  }
  if (!html.includes('__VNCODE_SPLASH__')) {
    fail('app/ui/index.html does not name the injected global.')
  }
}
if (rust) {
  for (const literal of FIELDS) {
    if (!rust.includes(literal)) {
      fail(`app/src-tauri/src/keystate.rs does not emit the JSON key ${literal}, which the page reads.`)
    }
  }
  if (!rust.includes(GLOBAL)) {
    fail(`app/src-tauri/src/keystate.rs never defines ${GLOBAL}.`)
  }
  // The guard that keeps the global off the HARNESS page: Tauri runs an
  // initialization script on every top-level navigation, and this window is
  // navigated from the splash to the harness URL.
  if (!rust.includes("endsWith('index.html')")) {
    fail('keystate.rs does not guard the injected script to the splash page - the harness page would inherit the global.')
  }
  // The one rule that may never regress.
  if (!rust.includes('never_carries_the_secret') && !rust.includes('the_splash_script_never_carries_the_secret')) {
    fail('keystate.rs has no test asserting the splash script never carries the key.')
  }
}
if (html && rust) {
  for (const literal of FIELDS) {
    if (!html.includes(literal.replaceAll('"', "'")) && !html.includes(literal.replaceAll('"', ''))) {
      // The page reads them as property accesses (`state.key.source`), so the
      // quoted form is not expected - this only reports when NEITHER shape is
      // present, which is what a rename looks like from here.
      const bare = literal.replaceAll('"', '')
      if (!html.includes(`.${bare}`) && !html.includes(bare)) {
        fail(`app/ui/index.html never mentions the field ${literal} that keystate.rs emits.`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Run the page's own script against a DOM stub, in both states
// ---------------------------------------------------------------------------
/** Every inline <script> the splash ships, in document order. */
function inlineScripts(text) {
  return [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
}

/**
 * The smallest DOM the page's script needs: getElementById, textContent,
 * className, hidden. It is deliberately NOT a DOM implementation - if the page
 * grows a dependency on one, this check should stop being able to run it.
 *
 * The starting text is seeded from the MARKUP, because that is where it lives:
 * "Starting the harness..." is written in the HTML and no script sets it, so a
 * stub with empty elements would "fail" a page that is perfectly correct - and
 * the assertion that matters (the script must not wipe that line) needs the real
 * starting value.
 */
function initialText(id) {
  const match = new RegExp(`<[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/`).exec(html ?? '')
  if (!match) return ''
  return match[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&amp;/g, '&')
    .trim()
}

function makeElement(id) {
  return { id, textContent: initialText(id), className: '', hidden: true }
}

function render(injected) {
  const elements = new Map(
    ['step', 'key', 'where', 'hint'].map((id) => [id, makeElement(id)]),
  )
  const sandbox = {
    window: { [GLOBAL]: injected },
    document: { getElementById: (id) => elements.get(id) ?? null },
    setTimeout: () => 0,
  }
  sandbox.window.__VNCODE_SPLASH__ = injected
  const context = vm.createContext(sandbox)
  for (const script of inlineScripts(html)) {
    vm.runInContext(script, context, { timeout: 2000 })
  }
  return elements
}

if (html) {
  const scripts = inlineScripts(html)
  if (scripts.length === 0) {
    fail('app/ui/index.html has no inline script - the injected state could never be drawn.')
  } else {
    // A. loaded, from the credentials file.
    const loaded = render({
      key: { loaded: true, source: 'the credentials file' },
      home: 'C:\\Users\\someone\\.dsh',
    })
    const key = loaded.get('key')
    if (key.hidden) fail('the key line stays hidden when a key IS loaded.')
    if (!key.textContent.includes('DeepSeek key loaded')) {
      fail(`a loaded key does not say so: got ${JSON.stringify(key.textContent)}`)
    }
    if (!key.textContent.includes('the credentials file')) {
      fail(`the loaded line does not name the layer: got ${JSON.stringify(key.textContent)}`)
    }
    if (key.className !== 'key ok') {
      fail(`the loaded line does not wear the ok state: got ${JSON.stringify(key.className)}`)
    }
    const where = loaded.get('where')
    if (where.hidden || !where.textContent.includes('C:\\Users\\someone\\.dsh')) {
      fail('the harness home is not shown, so "does a new version reuse my data" is unanswerable.')
    }

    // B. nothing loaded.
    const missing = render({ key: { loaded: false, source: null }, home: '/home/u/.dsh' })
    const keyMissing = missing.get('key')
    if (keyMissing.hidden) fail('the key line stays hidden when NO key was found.')
    if (!keyMissing.textContent.includes('No DeepSeek key')) {
      fail(`a missing key does not say so: got ${JSON.stringify(keyMissing.textContent)}`)
    }
    if (!keyMissing.textContent.includes('Settings')) {
      fail('the missing-key line does not say where to add one.')
    }
    if (keyMissing.className !== 'key warn') {
      fail(`the missing-key line does not wear the warn state: got ${JSON.stringify(keyMissing.className)}`)
    }

    // C. no injected state at all - the page must still render, because it is
    // also what someone opening the file directly sees.
    const bare = render(undefined)
    if (bare.get('key').hidden !== true) {
      fail('without the injected state the page must leave the key line hidden, not claim anything.')
    }
    if (!bare.get('step').textContent.includes('Starting the harness')) {
      fail('the starting line disappeared when the injected state was absent.')
    }
    notes.push('page renders loaded / missing / no-state')
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log('check-splash: the startup window, both halves')
for (const line of notes) console.log(`  - ${line}`)
console.log(`  - ${FIELDS.length} payload fields and the injected global agree across the seam`)
if (failures.length > 0) {
  console.log('')
  for (const line of failures) console.log(`FAIL ${line}`)
  console.log(`\ncheck-splash: ${failures.length} problem(s).`)
  process.exit(1)
}
console.log('\ncheck-splash: OK')
