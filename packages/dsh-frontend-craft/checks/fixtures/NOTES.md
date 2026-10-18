# Check fixtures

The six source files here are copied verbatim from Impeccable's own detector
fixtures (`tests/fixtures/antipatterns/` at commit
`2f46b7a8b059af00d20dd13b64dbe165e7c6a742`), Apache-2.0, and travel with the
corpus they test. `external-styles.css` belongs to `linked-stylesheet.html`.

`expected.json` was recorded by running the upstream CLI's own engine
(`impeccable detect --json --no-config <file>`, engine 0.1.15) over each file,
and it is the parity bar `check-frontend-craft.mjs` holds the vendored
WebAssembly build to: same rule, same line, same snippet, for every fixture.
`linked-stylesheet.html` is the interesting one - its findings come from a
sibling stylesheet the raw wasm export cannot read, and the host closes that gap
by inlining local `<link rel="stylesheet">` files before the scan.

`sample.tsx` is ours, not upstream's: it exercises the text engine on the file
type this plugin will see most. Its expected findings were recorded the same way.
