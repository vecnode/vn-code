---
name: rea-javascript
description: Inspecting JavaScript, Electron and website targets through REA - an app directory or .asar, the renderer/preload/main boundary, source maps and bundled modules, and how to attach to a RUNNING page instead of reading it statically. Covers when static is enough, when runtime observation is the only honest answer, and what the recovered modules do not tell you.
whenToUse: Use when the target is an Electron app, a packaged JavaScript desktop app, a .asar archive, a website or a minified script bundle, when a static read cannot answer a question about runtime behaviour, or when a recovered module has to be mapped back to the source the user sees in devtools.
---

# JavaScript and Electron targets

Static JavaScript analysis needs no native provider: the code is right there,
minified and bundled, and REA recovers modules, imports and the Electron
boundary between renderer, preload and main. That is often enough. It is not
enough for anything that depends on runtime values.

## Before you start

- An **app directory** is better than an `.asar`: REA reads the archive, but the
  app may load unpacked files beside it (`app.asar.unpacked`, sidecar binaries,
  native modules). Inspect the directory that contains both.
- The **entry points** are named in the app's `package.json` (`main`,
  `renderer`, preload scripts). Start there instead of grepping 40 MB of bundle.
- A **website** is a different target: the served page plus its scripts. If the
  question is about a computed value, the static read of the script is not the
  answer - the running page is.

## The three boundaries that explain most Electron bugs

1. **renderer -> preload**: `contextBridge.exposeInMainWorld` defines exactly
   what the page may call. If a method is missing there, the page cannot use it.
2. **preload -> main**: `ipcRenderer.invoke/send` names a channel; the main
   process has a handler for that channel. A channel with no handler fails at
   runtime, not at build time.
3. **main -> OS**: the actual file, clipboard, shell, notification call. That is
   where behaviour leaves the app, and where a question about "how does it
   copy X" is answered.

Read the preload for the exposed surface, then the main handler for the
behaviour, then the renderer for what the user triggers. Quote the channel name
and the handler - that pair is the evidence.

## Static versus observed

| Question | Static read answers it? |
|---|---|
| which module owns this command | yes |
| what the default setting is | yes (the literal) |
| why this value came out at runtime | no - observe the running target |
| why it only happens on one OS | no - the branch depends on the runtime |

If you need the running target, say so and ask the user for the local debugging
endpoint; the tool refuses a URL without `allowUrl:true`, and that opt-in is a
decision the user makes, not you.

## Minified code is still code

`a.b(c)` in a bundle is not anonymous: the module table, the imports at the top
of the chunk and the source map (when shipped) recover the names. When no source
map ships, name the recovered module by its path and the function by its line
range, and keep the identifier as it appears. Do not invent a name and then
quote it as if the code had one.
