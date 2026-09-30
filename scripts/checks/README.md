# scripts/checks

Standalone verification for the pack's JavaScript halves. None of these scripts
needs a running harness and none is part of the installers; run them after
touching a client bundle, a Node route or a shipped skill (they caught a real
"the tab body never got the hook it needs" bug during the alpha.4 editor work).
Node only - identical on Windows, macOS and Linux.

```sh
node scripts/checks/check-client-bundles.mjs    # module table + real React render
node scripts/checks/check-node-routes.mjs       # every Node route + the diagram tools
node scripts/checks/check-pdf-node.mjs          # the five pdf tools + the routes, against PDFs it builds
node scripts/checks/check-media-node.mjs        # the media tools + the routes, the pin, and both skills
node scripts/checks/check-skill-examples.mjs    # every fenced example in the diagram skills, parsed or compiled
node scripts/checks/check-media-examples.mjs    # every media/PDF example, shaped and then really RUN
node scripts/checks/check-dist-layout.mjs       # the distribution: ship list, bundles, half-to-half parity
DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs   # also opens a real file browser
```

(Windows PowerShell: `$env:DSH_CHECK_LAUNCH='1'; node scripts/checks/check-node-routes.mjs`.)

A check that cannot run on this host says so and skips loudly instead of
passing: the git routes need `git` on `PATH`, and the TikZ cases need a TeX
engine. (The live terminal socket that used to need a resolvable `node-pty` and
`ws` went with the terminals in terminal alpha.12.)

- `check-client-bundles.mjs` loads each browser half exactly the way the shell
  does (through `window.__ModuleLoader__.load`), activates it against a stub
  cordis context, and drives it with a **real React runtime** found in the
  profile or an npx cache (`react-dom/server`, so browser-only hooks such as
  `useEffect` are skipped, like any server render). Bundles covered:
  - `dsh-modal` - the `modals` service and its queue;
  - `dsh-ui-state` - the pack's durable UI state: the contract defaults the host
    schema mirrors, the `uiState` service (`get`/`set`/`unset`/`subscribe`), and
    the two COLUMN WIDTHS it restores through the `root` slot registration's own
    store handle - driven against a store double in every order that matters (the
    section first, the layout first, neither, a narrow frame, a remembered `0`
    collapsed through the toggle, and a store shape it must REFUSE rather than
    run blind). It also pins the same wiring from the other side: that
    `dsh-themes` and `dsh-terminal` resolve the service lazily, never declare it
    in `inject`, and keep their `localStorage` copies underneath;
  - `dsh-editor` - the tab type, `canOpen` (Markdown claimed, previews vetoed),
    the guide contract, the **Preview** hand-off naming the registry's kind (and
    the fallback when the preview type is absent), the blank-document save path,
    the theme-compartment source invariants, and the shell languages (alpha.10:
    the extension map in the client source, and the built `cm6.min.js` actually
    carrying `StreamLanguage` + `shell` + `powerShell` + `batch` - a bundle that
    was not rebuilt after entry.js changed fails there);
  - `dsh-open-in-app` - the route split (file managers to the pack route,
    everything else to the shipped one);
  - `dsh-themes` - the header seats and their orders, the theme registry
    snapshot, the Nord/Monokai/Hacker extensions (their token maps, their shared
    token names and their glyphs), the
    Session-log download seat, the screenshot control, the **Markdown paper**
    (the light declarations it copies out of fake theme stylesheets, and the
    dark ones it must skip), the left-top-bar branding and the header ring; plus -
    the one section that loads a HARNESS bundle rather than a pack one - the
    **extension-theme regression** against the **real ui-theme runtime**: choosing
    Nord applies it through the real service, `adopt()`'s re-adopt of the durable
    built-in (triggered by ANY settings-document change) no longer discards it, a
    built-in chosen on a surface that writes durably still wins, and this
    control's own menu always goes back to a built-in. It skips loudly when the
    host has no copy of ui-theme, because a stub theme service is exactly what
    let that bug ship;
  - `dsh-gittree` - registration, guide order, the history-only body, the chip
    title; and alpha.5's **rail**: its lane layout is DRIVEN through the bundle's
    pure `__internals.graphLayout` (a linear history is one lane with the line
    running through every row; a merge opens a second lane, edges to both parents
    and collapses back at the commit they share; a parent outside the page ends
    its lane), the pull-request and ref chip readings are driven the same way, the
    stylesheet's own `.dsg-commitRow` height is read back and compared with the
    `ROW_HEIGHT` constant the node's geometry is derived from (the one coupling
    that can silently rot), the bundle is pinned to measure nothing
    (`new ResizeObserver(` / `getBoundingClientRect(` absent), and the rendered
    rail of a four-commit merge is checked for one rail per row, the lane widths,
    the hollow merge node, both curves, the node on the lane's centre line and the
    `#12` chip;
  - `dsh-terminal` - the bundle id, both seats, order 30, and the geometry
    invariants the dock must keep at the source level (never the frame's height,
    inset the two columns, follow the left bar through the mutation observer
    *and* the column `ResizeObserver`), plus the dock's ONE view as a static
    render can see it: no chip strip, no `+`, no view toggle, and the Agent brand
    wearing the log's state. **alpha.12 is pinned by ABSENCE**, because the
    terminal half must not come back: the check fails if a socket, the vendored
    engine (`DSHTerminal`), the emulator registry (`DockRuntime`), the view
    sentinel (`ACTIVITY_VIEW`), the chip strip (`dst-chips`), `MAX_TERMINALS` or
    `onRunInTerminal` reappears anywhere in the browser half. The shared-height
    arithmetic is DRIVEN through the bundle's pure `__internals.adoptDecision`
    (news moves the dock; the pointer, our own echo, an outstanding write, the
    height already in force, an unready section and an absent value do not).
    The agent view is pinned on the same terms: the bundle reads this package's
    own `/activity` route rather than the browser's session window and polls only
    while something is subscribed and the tab is visible, a multi-line command is
    drawn like any other with nothing offered to run it - and then the whole read
    model is DRIVEN with hand-built session events: `parseExecCall` (a missing
    `description` marks the persistent shell, `read` is not a command),
    `parseExitMarker` (consumed, a signal is not an exit code, marker-like text
    mid-output left alone), `stripAnsi`, `formatDuration`, `filterActivity` and
    `buildActivityFromEvents` (grouping by prompt, injected context does not open
    a group, a failure read off its marker, a call with no result still running, a
    persistent shell claiming no exit status, a result outside the tail kept but
    unnamed), the view itself RENDERED from a hand-built log, plus
    `activitySignature`, which is what keeps an unchanged poll from re-folding the
    log. alpha.11 pins the COUNTS the bar wears as the commands' own - a
    failed `read` folds to zero failures (and to `otherFailed: 1`), its tooltip
    sentence is asserted as text, and the bounded retry (1.5 s over the first four
    reads with no answer, cleared by an answer) and the dock forgetting the
    conversation it no longer belongs to are pinned at the source level;
  - `dsh-rightbar` - the forked bar's own source invariants (module-table id,
    the module-table surface other bundles inject);
  - `dsh-diagrams` - both tab types and their seats, all six tool cards, and the
    four load-bearing properties of the render path (parse-before-render,
    `suppressErrorRendering`, the plugin's own container, the `finally` sweep),
    plus the zoom ladder moving the layout box rather than a transform, the
    Desktop-export wording and the four verdict labels;
  - `dsh-pdf` - the reader type and the `pdfs` index page, every tool card, the
    scanner's own route call, and the parts of the reader that are contracts
    (the text layer's scale variables, the lazily drawn thumbnail rail, the
    outline resolved through pdf.js, the engine fetched from the package's own
    routes rather than inlined, and - alpha.5 - that the reader caches **no**
    PDF bytes and destroys its loading task, because pdf.js transfers and
    detaches the array it is handed);
  - `dsh-image` - the image type and its seat, the extension band and the
    `canOpen` refusals, the chip title and the deliberate absence of a guide
    entry, the tab body and the title seat rendered as markup, and the viewer's
    load-bearing rules by name: the layout-sized zoom (never a transform), the
    measured overflow behind the grab cursor, the non-passive wheel listener
    anchored at the pointer, the 1x1 pixel sampler, the checkerboard, the
    pixelated threshold, the base64 decode, and the fact that the bundle has no
    `fetch` and no route of its own because bytes come from the shipped
    `workspaceFiles` remote.
  - `dsh-audio` - the audio type and its seat, the extension band and the
    `canOpen` refusals, the chip title and the deliberate absence of a guide
    entry, the opening markup, and the viewer's load-bearing rules by name (the
    layout-sized zoom, the viewport-anchored canvas, the non-passive wheel
    listener, the audio-clock playhead, the streaming window read and the host
    cap a refusal teaches it). It is also the one section that **builds its own
    audio** - a RIFF/WAVE, an IFF FORM and a FLAC, byte by byte - and drives the
    bundle's pure half (`exports.__internals`) to assert the decoded numbers:
    sample rates, channel counts, bit depths, durations, a half-scale sine's
    envelope, a DC half followed by real silence, the 24-bit two's-complement
    edges, unclamped IEEE float, `WAVE_FORMAT_EXTENSIBLE`, the G.711 laws, a
    truncated file reported as unknown rather than silent, an unsupported codec
    refused by name, and the peak pyramid's bucket arithmetic - including that a
    WINDOWED decode builds the same pyramid as a whole-file one.
  - `dsh-video` - the video type and its seat, the extension band and the
    `canOpen` refusals (including that it claims both address shapes and that
    audio formats are deliberately NOT claimed), the chip title and the absence
    of a guide entry, the opening and address-less markup, and the tab's
    load-bearing rules by name: the **bytes stay on the host** (`<video>` is
    handed a URL to dsh-media's Range-capable route, with no `arrayBuffer`, no
    blob and no `workspaceFiles` read anywhere in the bundle), the aborted
    in-flight probe, the POST-then-poll conversion whose poll keys on the job's
    ID rather than the job object, the "play it anyway" overlay, and the
    sentence a profile without dsh-media is shown. Its pure half is driven too:
    the POSIX / Windows-drive / UNC absolute addresses all reassemble correctly,
    which is the parser a wrong answer would turn into another file.
- `check-node-routes.mjs` imports each Node half, captures the handlers it
  registers on the `connection` service, and drives them with real `Request`s
  against temp workspaces and a temp `DSH_HOME`:
  - **editor** - containment, text-only reads, create-only semantics,
    optimistic concurrency, atomic save;
  - **open-in-app** - the launcher's wire validation and the status a real launch
    answers (the actual window is behind `DSH_CHECK_LAUNCH=1`);
  - **gittree** - the three read-only routes against a real scratch repository
    (init -> commit -> modify -> untracked -> a workspace that is a subfolder ->
    a branch -> a `--no-ff` merge -> a tag), asserting scope, the brief form, the
    root commit's file list, the option-injection guard and the GRAPH fields the
    tab's rail is drawn from (a merge's two parents, the `%D` ref `HEAD` points
    at, a tag ref, and a root commit with no parents);
  - **terminal** - ONE route, and the check asserts that in both directions. The
    row is driven with a `connection` **and** a `webServer` service offered, and
    it must register exactly `/api/dsh-terminal/activity` and **no upgrade** -
    alpha.12 deleted the PTY, the socket, the vendored assets and the `/health`
    probe, so their return is a regression rather than a feature. The route itself
    is driven against a stubbed live session and must send only the three event
    types the panel draws (injected context and assistant streams dropped), in log
    order, answer `NOT_LIVE` for a conversation that is not open on this host (a
    200 - a fact about the host, not a bad request), `UNREADABLE` for a log that
    will not read, 400 without a session id, and answer a conversation past the
    budget with its **tail** (`hasMore` set, the newest kept, and one oversized
    newest command still sent);
  - **themes** - the screenshot route's type/signature/size refusals and the
    create-exclusive write onto a redirected Desktop;
  - **ui-state** - the pack's settings form with no route to capture: the row is
    driven against a stub so the check can assert what `apply` declared (the
    `ui-state` entry's own `.volatile()` Config - EVERY field volatile, since a
    plain field is ordinary configuration and never reaches a form - the
    `configure({ auto: false })` page opt-out, asked for through the OPTIONAL
    settings service) and that the schema really resolves the defaults the
    browser half mirrors - drift between those two is what would make a fresh
    install read a field nobody set - plus the ladder and height refusals and the
    pre-paint zoom row (silent at the resting level, carrying level and seam
    marker otherwise, and silent when the row got no Config at all). The row is
    imported through the RUNNING ENTRY of the pinned harness line, because the
    schemastery that can declare a volatile field is the pinned line's own copy
    and a stale `$DSH_HOME/profiles` mirror holds an older one; a host with no
    install of the pin skips the section loudly instead of grading a form the row
    could not declare;
  - **diagrams** - the route table, the vendored-engine hash, a real Mermaid
    parse, a real TikZ compile when the host has an engine, the lint warnings,
    the empty-source refusals, `diagram_verify` leaving the revision alone, the
    render-report round trip (drawn / failed / stale / pending), an
    ambiguous-patch refusal, the create-exclusive export onto a redirected
    Desktop (never the workspace), the source budget, a cache hit keeping the
    verdict it was cached with, a `box` sequence diagram validating, a bare
    `axis` chart compiling, and every tool result validated against the schema
    the tool declares.
- `check-pdf-node.mjs` builds its own PDFs (a two-page report with a labelled
  value, a one-page scan that is one image and no text, a twelve-page document
  for the per-call caps, one nested in a subfolder and one inside `node_modules`
  to pin the index walk, a truncated copy), so it needs no TeX, no poppler and no
  network, and drives all five `pdf_*` tools, the routes, the path policy and the
  vendor `--check`. The scanner is verified in two halves on purpose: the tool as
  the agent calls it (which on a host without tesseract means pinning its
  refusal) and the pipeline directly through a stub OCR engine, which is what
  proves on any host that the raster handed to the engine is the one drawn for
  that page, that a second call is a cache hit, that another dpi/psm/language is
  a new recognition, and that the per-call cap names the pages it left. It also
  drives the vendored engine with the READER's own factory URLs (rebuilt out of
  the shipped client source) and, since alpha.5, with **one `Uint8Array` handed
  to `getDocument` twice** - the second hand-off must FAIL, because pdf.js
  transfers and detaches the first - and with two fresh arrays, which is the rule
  the reader's per-open byte read rests on.
- `check-media-node.mjs` drives `dsh-media`'s host half the way the agent and the
  video tab do - module import, `apply(context)`, then real tool calls and real
  `Request`s against the captured route table. It is deliberately split by what it
  can promise on ANY host:
  - the **pin** is exercised completely without ffmpeg and without the network:
    this file builds a synthetic build tree, packs it with the host's own `tar`,
    hashes it, serves it over a loopback HTTP server and drives the whole
    provisioning pipeline - download, SHA-256 verification, `tar` unpack, the
    atomic `.partial`+rename install, the `install.json` stamp, the lock, the
    cleanup - then asserts the resolution order (explicit env path, then PATH,
    then the provisioned copy), that a second call is a no-op, that a hash
    MISMATCH installs nothing and leaves no stamp, and that an unpinned platform
    is refused in words. `DSH_MEDIA_NO_INSTALL=1` and a temp `DSH_HOME` are set
    before the module is imported, so no check run can ever start a real
    download or touch `~/.dsh`;
  - the **ffmpeg-dependent half** (real probing, `media_run`'s argv handling and
    its no-overwrite default, frames and contact sheets, the routes, a real
    remux and a real transcode) runs when the host has ffmpeg and **skips
    loudly** when it does not, because a check that downloads 170 MB to pass is
    not a check. It builds its own fixtures (`testsrc2` + `sine` to H.264/AAC, an
    mpeg4 AVI, an MKV copy, a PNG) so it needs no files on disk;
  - the **route contracts** are asserted by name either way: `/file` answers
    200/206/416 with matching `content-length`/`content-range` for whole, closed,
    suffix and unsatisfiable ranges, HEAD answers without a body, the video
    extension gate is 415 for anything else, `/report` is the same facts the tool
    prints, the remux job hands back a 32-hex cache key which `/file?cache=` then
    serves (seekably), asking twice joins the finished job, a file the browser
    already plays starts no job at all, and `parseRange` is driven directly on
    seven shapes including the nonsense ones;
  - the **host with NO ffmpeg** is a section of its own, because "a machine
    without ffmpeg degrades in a sentence" is a promise the video tab's whole
    no-ffmpeg overlay rests on: a SEPARATE module instance is imported with
    broken `DSH_MEDIA_FFMPEG`/`DSH_MEDIA_FFPROBE` paths and
    `DSH_MEDIA_NO_INSTALL=1`, and must load, must answer `/report` with
    `200 {ok:true, unavailable:true}` rather than a 500, must name the file it
    could not inspect, and must let a tool call explain itself instead of
    throwing. The environment is restored in a `finally`, so nothing later in
    the run inherits it.
- `check-skill-examples.mjs` extracts every fenced example from `skills/**/*.md`
  and parses or compiles it with the plugin's own engines, so a copy-pasteable
  source that no longer works fails the run instead of misleading the next
  agent.
- `check-media-examples.mjs` is the same idea for the two families whose examples
  are TOOL CALLS rather than source: it walks both media skills **and their
  reference files** plus `pdf-analysis`, and holds them to two tiers. **Shape**
  (always, hermetic) reconstructs each example's JSON across the lines it spans
  and parses it - a `media_run` argv array, an ffprobe invocation object, or a
  `pdf_scan { ... }` pseudo-call - which is what catches a stray comma, a
  dropped quote or a line of prose welded onto the end of an array. A block with
  a language in its info string is a sample of output rather than an example, and
  `no-check` still marks one deliberately un-runnable template. **Execution**
  (only when this host has ffmpeg) builds a fixture set with real ffmpeg under
  the very names the documents read (`clip.mp4`, `two.mkv`, `withsubs.mkv`,
  `attached.mkv`, `a.mp4`, `pal.png`, `list.txt`, `subs.srt`, `rotated.mp4`, a
  genuinely interlaced `interlaced.mp4`, an HDR `hdr.mp4`, a transport-stream
  `clip.ts` and a variable-rate `vfr.mp4`), and then runs every example whose
  inputs are all fixtures, in a directory of its own, copying each fixture the
  argv reads *or merely mentions* - a path inside a filter value never follows an
  `-i` - through the argv shape `media_run` builds (`-hide_banner -loglevel
  warning -nostdin`, and `-y` where the tool puts `-n`, because here nothing is
  precious). It reads **this build's** own `-encoders` and `-filters` before each
  one, so an example that needs an encoder or a filter the build lacks is skipped
  with its name rather than failed; the same for an example whose input is not in
  the fixture set. Every skip is printed with its reason, never counted as a
  pass: that list is the readable measure of how much of the documentation has
  actually been executed here. It has teeth - a deliberately introduced
  `["-i","clip.mkv","-c","copy","clip.mp4",]` failed it and named the line, and
  it caught two of its own author's examples while this skill set was written (a
  Windows filter path that only works with the doubled backslash, and a graph
  whose second labelled output was never mapped). The PDF family is shape-only on
  purpose, because driving those tools needs real PDFs and `check-pdf-node.mjs`
  already builds its own.
- `check-dist-layout.mjs` covers the distribution feature, which is a COPY of
  this repository produced by two independent halves (`scripts/dist.ps1` on
  Windows, `scripts/dist.sh` everywhere else). It reads
  `scripts/dist-manifest.txt` and fails on the quiet failures: a bundle under
  `packages/` that no include rule carries (it would silently not ship), a lost
  `skipdir node_modules` (200 MB of build inputs would enter the archive), a
  rule reaching outside the repository, a bundle `.dsh-version.json` lists but
  `packages/` does not have, a flag or a generated file only ONE half knows
  about, the two sentinel lists drifting apart (the guard that catches a copy
  which flattened or nested a tree), a half that stopped redacting the launch
  token, `dist/` missing from `.gitignore`, and a workflow that stopped building
  one of the four targets or dropped the end-to-end `-Verify`. Node only, no
  build, no network.

  It also pins the RUNNER LABELS, which is the one failure local running cannot
  catch: the first cut asked GitHub for `macos-13`, an image that has been
  retired, and the whole run died at scheduling time before any step could
  report why. The matrix's own `- os:` values are what it reads - the comments
  above the matrix name the retired labels on purpose, to record why they left -
  and the ARM64 legs must be marked `experimental` (continue-on-error) while
  their toolchains settle, so a preview-image surprise cannot block a release.
  Every launcher lives in `scripts/`, so the workflow's `paths:` filter has to
  watch `scripts/**` - a change to any of them would otherwise build nothing.

  **All of that is skipped LOUDLY while the workflow is parked.**
  `.github/workflows/distribute.yml` was removed on purpose for now, so this one
  file is read OPTIONALLY (`skip the workflow section ...`) and every assertion
  above comes back the moment the file does - it is not a check that quietly
  stopped looking.

  And it pins the CONSOLE CONTRACT, which is what keeps five Windows launchers
  and four POSIX ones behaving the same way: each Windows entry point must call
  `console/adapt.cmd`, keep the `if not defined VNCODE_CONSOLE set
  "VNCODE_ARGV=%*"` guard, mention `%*` exactly once (a second occurrence
  would replace the caller's flags with `--from-terminal` after the Windows
  Terminal relaunch), forward `%VNCODE_ARGS%`, honour `VNCODE_PAUSE` and
  handle both of `adapt.cmd`'s exit codes; each POSIX entry point must source
  `scripts/console/theme.sh` and never invoke PowerShell (comments explaining
  that rule are stripped before the test, so the rule can still be documented);
  the `.sh` workers must accept `-Help` and `-NoPause` (an unknown option is a
  hard error in all of them, so a flag the entry forwards and the worker never
  heard of breaks the run); `adapt.cmd` must not `setlocal`; and `theme.sh` must
  stay POSIX - no `[[ ]]`, no `function`, no arrays.

  It also RUNS the no-argument path, which is the one path a person actually uses
  and the only one nothing here ever drove: `adapt.cmd` is called through a
  temporary batch with nothing in `%*` (a double-click), and the run must reach
  its end with both argument variables defined as one space rather than aborting
  with `set was unexpected at this time.` The trap is that cmd has no empty
  variable - `set "X="` REMOVES X - and `%X:-flag=%` on an undefined X expands to
  literal text, turning the `if` around it into a one-token statement that kills
  the WHOLE file. Every launcher therefore flashed a window and closed, printing
  nothing, while every flagged run worked; an `if defined X` guard does not help,
  because cmd expands every `%VAR%` on a line before running any of it.
