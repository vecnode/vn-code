# Cutting a vncode release

**A release is one artefact.** `vncode-<version>.zip` is a `git archive` of the repository
at the tag, and it is the whole distribution: the pack, the launchers, the docs and the pin.
Nothing is compiled, so nothing is built per OS: unzipping the zip yields a working
installation on Windows, macOS and Linux alike, with no second archive and no ship list.

## What publishing a tag does

`.github/workflows/release.yml`, on `v*` (or `workflow_dispatch` with an existing tag):

1. **gate** - calls `ci.yml` through `workflow_call`, the same workflow a pull request
   runs. One job, `ubuntu-latest`, a `node:24` container: `git` installed, then
   `check-no-secrets.mjs` and `check-scripts.mjs`. A red gate stops the release **before**
   anything is published.
2. **archive** - the tag itself is archived into `vncode-<version>.zip` and attached. The
   zip is the repository at the tag, not a file list somebody maintains, so it cannot fall
   behind the tree.
3. **publish** - the release becomes visible with its one artefact attached.

A tag is the only thing that publishes. There is no separate packaging step to remember,
and nothing that can fail for one platform while another succeeds.

## Cutting one by hand

The workflow is the only ritual that ships. If it is unavailable, the same steps run
locally:

```sh
git status --porcelain            # expect: empty
node scripts/checks/check-no-secrets.mjs
node scripts/checks/check-scripts.mjs
```

**Smoke it as a user would.** From the checkout, on each OS:

```sh
./scripts/setup/install.sh        # once, against the home in use
./scripts/run-web.sh              # start the harness and open the tab
```

The install must add the bundles and change nothing else. The run must reach a served page
in a browser, print the home it chose, and Ctrl+C must stop it. On Windows, the same two
steps with `scripts\setup\install.bat` and `scripts\run-web.bat`.

Then tag and push; the workflow does the rest:

```sh
v=$(node -p "require('./package.json').version")
git add -A; git commit -m "release: vncode $v"
git tag -a "v$v" -m "vncode $v"; git push origin main "v$v"
```

The zip is cut from the tag itself, so a dirty tree cannot leak into a release.

## What NOT to do

- **Do not add a second artefact, for any platform.** The same files run everywhere, so a
  second archive is only a second thing to keep in step.
- **Do not hand-edit or re-zip the archive.** It is `git archive` of the tag; a release that
  does not match its tag is not the release.
- **Do not re-cut a tag** once its archive has been handed to somebody.
- **Do not attach an artefact after the release is published** - regenerate it from the tag
  instead.

[BUILD.md](BUILD.md) is how it runs and how a change is checked; [DEPLOY.md](DEPLOY.md) is
what a distribution promises; [scripts/checks/README.md](../scripts/checks/README.md) lists
every check.
