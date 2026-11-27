# dsh-rea

Reverse engineering as a surface, over the user's own [REA](https://github.com/morluto/rea)
installation (MIT). Five `rea_*` tools give the agent a target, an evidence
store and a report — without wrapping REA's forty MCP tools one by one, and
without installing anything.

## Why a plugin at all

REA already speaks MCP, and a harness can mount that server directly. What a
conversation needs on top of it is the shape of an investigation: one question,
one target, one stored report, a slice to read it in, and a document a person
keeps. That is the whole of this row — and it is the part that lets the agent say
*which* evidence a claim rests on.

## The tools

| Tool | What it answers |
|---|---|
| `rea_status` | Is REA installed, which version, which commands THIS installation offers (`help:true`), and what a native analysis still needs (Hopper / Ghidra / IDA / Kuna are the user's own). Names the install command; installs nothing. |
| `rea_inspect` | One REA command against one target → REA's `--json`, stored as an investigation. Returns a summary and an id. |
| `rea_read` | A stored investigation: `summary` (what it is, its top-level shape) or `raw` with a 1-based line range, so a megabyte report is walked, not swallowed. |
| `rea_snapshot` | `list`, `export` (one JSON bundle into the workspace) or `import` (store one from a bundle), so a finding is reproducible elsewhere. |
| `rea_report` | A Markdown evidence report in the workspace: the question, the target, the top-level findings, the investigation id, and the limits. |

## The rules this row keeps

- **The target is scoped.** A local path must be inside the session workspace,
  or inside a folder the user authorised for that call (`allowRoot`). A URL is
  refused unless the call passes `allowUrl:true` — this package starts no
  network egress of its own.
- **Argv, never a shell.** `spawn(command, args)`: a path with a space, a quote
  or a `;` is one argument.
- **Output is bounded.** 2 MB per captured stream, 32 MB per stored report, a
  timeout with a kill. An oversized report is refused by name.
- **Nothing is installed.** REA, its providers and their licences are the
  user's. `rea_status` says what to run and stops.
- **The report carries its limits.** A decompiler prints pseudocode; a static
  pass sees code, not behaviour. Every report repeats that, names the provider,
  and keeps the claims that are readings apart from the ones that are
  observations.

## Skills

Five, and they teach the loop rather than the flags: `rea-investigate` (the
order and the scope), `rea-native` (providers, one function at a time, what to
quote), `rea-javascript` (app/asar/website, the three Electron boundaries,
static vs observed), `rea-rebuild` (a recovered rule → code + tests, with the
level of agreement stated), `rea-ethics` (the three permissions — target, tool,
output — and what to refuse).

## What it deliberately does not do

- No MCP server of its own, no engine vendored, no provider installed.
- No analysis of a target the user has not scoped.
- No claim that a finding is behaviour: that is a test, and it belongs to
  `rea-rebuild`.

## Requirements

- REA: `npm install --global rea-agents` (or `npx rea-agents@latest setup` to
  register its MCP with an agent). `DSH_REA_CLI` pins a binary PATH does not
  carry.
- Native analysis: a provider you own. Static JavaScript and .NET need none.

## Check

```sh
npm run check      # node checks/check-rea.mjs — 73 assertions, no REA needed
```

The live probe runs `rea --version` when a binary is present and says loudly
when it is not.
