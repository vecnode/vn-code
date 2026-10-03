/**
 * patches/index.mjs - the repository's own patches to the vendored Excalidraw build.
 *
 * WHY THIS FILE EXISTS: SECRET SCANNING. Every published build of Excalidraw
 * carries its own OSS Firebase configuration as a string literal
 * (`VITE_APP_FIREBASE_CONFIG`), and that string contains a Google API key -
 * `AIza...` - because Firebase WEB api keys are PUBLIC by design: they identify
 * a project, and access is decided by Firebase security rules and App Check, not
 * by the key. Vendoring Excalidraw therefore put a key-shaped literal into this
 * public repository, GitHub's secret scanning opened a `google_api_key` alert
 * against `lib/vendor/excalidraw/excalidraw.min.js`, and that alert can never be
 * resolved honestly - it is Excalidraw's key, not this pack's, so it can be
 * neither rotated nor revoked here, and removing the file from HEAD does not
 * close an alert raised against a commit that still exists.
 *
 * WHAT IS DONE ABOUT IT: the `apiKey` VALUE is blanked, in every file the build
 * reads from the pinned package's own `dist/`. Nothing else in the config moves,
 * so the constant keeps its exact shape and anything that parses it keeps
 * parsing; the only behavioural difference is that this copy cannot talk to
 * Excalidraw's Firebase project - which is the correct behaviour for a vendored
 * editor that enables no collaboration at all, and if anything ever does ask for
 * it, a Firebase config error names the cause instead of silently connecting to
 * someone else's database.
 *
 * It is a BUILD patch rather than a hand edit to the committed artifact, because
 * the artifact IS the build: a text diff against a 3 MiB minified file would rot
 * on the next version bump, while this runs on every build, is named in
 * VERSION.json's `patches`, and is proven by the artifact hash the tracked check
 * re-computes (`node build.mjs --check`).
 */
import { readFileSync } from 'node:fs'

/**
 * One credential-shaped literal and what replaces it.
 *
 * The pattern is the serialized form of Excalidraw's own config object, matched
 * by KEY rather than by the secret's text, so a version bump that rotates the
 * key is redacted just the same and nothing here has to record the value it is
 * removing.
 */
const REDACTIONS = [
  {
    name: 'firebase-api-key-redacted',
    pattern: /("apiKey"\s*:\s*")[A-Za-z0-9_-]{20,}(")/g,
    replace: '$1$2',
  },
]

/** The pinned package's own dist tree - the only files a patch may rewrite. */
const PATCHED_ROOT = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]/

/**
 * Apply every redaction to the files the pinned Excalidraw package contributes.
 *
 * An esbuild `onLoad` hook is the honest seam here: it sees a module's SOURCE,
 * before bundling and minifying, so the string never reaches the artifact and
 * the artifact stays a pure function of the pinned versions plus this file. A
 * file that needs no redaction is left to esbuild's own loader (`null`).
 *
 * @param api - the esbuild plugin API.
 */
export function setup(api) {
  api.onLoad({ filter: /\.(js|mjs|cjs)$/, namespace: 'file' }, (args) => {
    if (!PATCHED_ROOT.test(args.path)) return null
    const original = readFileSync(args.path, 'utf8')
    let contents = original
    for (const redaction of REDACTIONS) contents = contents.replace(redaction.pattern, redaction.replace)
    if (contents === original) return null
    return { contents, loader: 'js' }
  })
}

/** Named in VERSION.json's `patches`, so the artifact says what produced it. */
export default [{ name: 'firebase-api-key-redacted', setup }]
