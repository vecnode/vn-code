# dsh-modal (alpha.2)

**The pack's shared dialog surface** for the web GUI: a client-service plugin whose browser half mounts one body-level overlay and provides the **`modals`** service, so any client plugin — in this pack or in a deployment — opens a dialog with `ctx.get('modals')` instead of shipping its own prompt markup.

One dialog shows at a time and every dialog in the app looks and behaves the same. It is deliberately not a slot occupant: the host creates its own container on `document.body` and renders it with `react-dom/client`'s `createRoot`, so it involves no slot registration, no layout contribution and no ordering constraint — which is exactly what makes the service callable from every plugin.

## What it adds

```js
const modals = ctx.get('modals')
const values = await modals.open({ title: 'Save new file', fields: [...], submit })
```

| Call | Answers |
|---|---|
| `open(spec)` | a Promise: `null` when the dialog is cancelled, otherwise the field values — or whatever `spec.submit` returned |
| `alert(specOrMessage)` | a Promise that settles when the single-button dialog is dismissed |
| `confirm(specOrMessage)` | `true` only when the confirm button was used |
| `prompt(spec)` | the typed string, or `null` when cancelled |
| `close(result?)` | closes whatever is open, resolving it with `result` (default `null`) |
| `isOpen()` | whether a dialog is currently up |

`spec` (all fields optional): `title`, `message`; `fields` — `[{ name, label?, value?, placeholder?, hint?, mono?, required?, maxLength? }]`, text inputs, the first one focused and selected; `validate(values)`, returning an error **string** to show inline and block the submit; `submit(values, …)`, async work that runs **while the dialog stays open**; `confirmLabel` / `cancelLabel` / `busyLabel` (`cancelLabel: null` renders no cancel button, i.e. an alert); `danger`, which paints the confirm button as the error colour; and the rich pair `content` + `size`.

**Rich dialogs** pass `content` — a render function handed `{ close }` that owns the whole body — instead of `fields`, for a dialog that is a browser rather than a question (a list beside a document, a picker, a form of its own). Fields, `validate` and `submit` do not apply to one: the content owns its own work and closes the dialog itself through the `close` it is handed, which settles the `open()` Promise with whatever it passed. `size: 'lg'` gives it the roomy frame (min(1120px, 94vw) × min(800px, 90vh)). The overlay, the Escape handling, the focus restore and the one-dialog-at-a-time queue are still this package's, so a rich surface never ships its own overlay.

`submit` is the point of the whole surface: a save, a rename or a request that can fail runs with the dialog still on screen, so the failure is reported **inside** it and the user keeps everything they typed. Throwing (or rejecting) shows the message and leaves the dialog open; resolving closes it and settles the `open()` Promise with the returned value, or the values when it returns `undefined`.

## How it plugs in

`cordis.patch.yml` inserts the `modal` row and patches nothing else. The service is published with `ctx.reflect.provide('modals', …)` — the same client-service mechanism `dsh-rightbar` uses for `sidebarRightTabs` / `sidebarRight`.

Consumers: [`dsh-editor`](../dsh-editor) uses `open` for the save-as dialog (name + extension) that creates a new file, and [`dsh-skills`](../dsh-skills) opens its Skills browser as a **rich** dialog.

## Limits

- **A mask click does not close a rich dialog.** It can hold unfinished work, and a stray click outside it must not throw that away; Escape and the content's own Close control are the ways out. For a field dialog the cancel paths are the Cancel button, **Escape** (captured on the document, so the pane underneath never sees the key) and a click on the mask — none of which fires while `submit` is still running.
- Two calls that overlap **queue**: the second dialog opens when the first settles, so two racing saves can never replace each other's UI.
- Focus moves to the first field and returns to whatever had it when the dialog closes.

## Verify

```sh
node scripts/checks/check-client-bundles.mjs
```

## Install

The repo launcher (`scripts\install.bat` on Windows, `./scripts/install.sh` on macOS/Linux) auto-discovers this package — it is a standard `dsh.bundle`, so a bundle the profile does not list yet is added by one plain launcher run (no `-Force`). The web profile links it into this repo, so code edits need a restart of `npx @deepseek-ai/dsh web` plus a hard browser refresh; `scripts\run-web.bat` / `./scripts/run-web.sh` starts that server and opens the URL it prints in Chrome.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'modal' row (nothing else patched)
lib/index.js       Node half: a no-op row, so the client bundle joins the boot graph
lib/client.js      Browser half: the overlay host, the queue, and the `modals` service
```
