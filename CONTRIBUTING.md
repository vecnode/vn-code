# Contributing to vn-code

Read [AGENTS.md](AGENTS.md) first: it carries the hard rules this repository is
built on (one install target, nothing patches core, OS-neutral plugin code, zero
npm dependencies, no secrets) and the list of checks that prove a change. A patch
that ignores them is not mergeable, however good it is.

## License of a contribution

vn-code is **AGPL-3.0-only** ([LICENSE](LICENSE); vendored pieces keep their own
terms in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)). By contributing you
agree to:

1. release your contribution under the AGPL-3.0-only, and
2. the [CLA](CLA.md), which lets the project owner also license it commercially.

Open the pull request with this sentence in it:

> I have read the CLA in CONTRIBUTING.md and I agree to it.

That is the whole ceremony — no bot, no separate form.

## Before you push

```sh
node scripts/checks/check-no-secrets.mjs   # first, always
node scripts/checks/check-scripts.mjs
node scripts/checks/check-node-routes.mjs
node scripts/checks/check-client-bundles.mjs
```

…and the check that owns the area you touched (media, pdf, browser, audio,
skills or shell) — the list is in [AGENTS.md](AGENTS.md) under *Verifying a
change*. A check that cannot run on your host must say so loudly; never silence
one and never weaken one to make a change pass.

If the package ships its own `checks/`, run `npm run check` in its folder too.

## Style

One page per document. Comments and docs state the **rule and the measurement**
behind it — the fact a future editor must not break — not the changelog. A
package README describes what the plugin does and where its limits are, including
the ones that are deliberate.

## Security

Do not open a public issue for a vulnerability. Report it privately, as
[SECURITY.md](SECURITY.md) describes.
