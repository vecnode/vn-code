/**
 * The vendored Excalidraw surface, built into ONE classic script.
 *
 * WHY A CLASSIC SCRIPT. The harness reads every client bundle at boot, so a
 * 3 MiB editor can never be inlined into `dsh-canvas/lib/client.js` - it is
 * fetched from this package's own route on the first use and evaluated as a
 * classic script, which is the same shape the editor uses for CodeMirror and
 * dsh-pdf uses for pdf.js. `globalThis.DSHExcalidraw` is the one global it
 * leaves behind.
 *
 * WHY REACT IS INLINED. Excalidraw takes React as a PEER (^17|^18|^19), and a
 * script fetched from a route cannot reach the shell's module table (that is
 * `require('react')` inside a client bundle, not an import a blob or a script
 * tag can resolve). So React is bundled with it and Excalidraw owns its own
 * instance and its own root - which is safe precisely because nothing shares
 * hooks or context across that boundary. The consequence is stated: this is a
 * SECOND React on the page, and nothing may pass a component between them.
 *
 * WHAT IS EXPOSED, and why each name is here: `mount` for the surface, and the
 * data half the agent tools will need - skeletons in
 * (`convertToExcalidrawElements`), a `.excalidraw` document out
 * (`serializeAsJSON`), the document back in (`restore`/`restoreElements`), and
 * the two export paths (`exportToBlob`/`exportToSvg`) that replace this pack's
 * own painter for preset-size output.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  getSceneVersion,
  restore,
  restoreElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw'

/**
 * Mount one Excalidraw into an element.
 * @param element - the element Excalidraw owns from then on (it must be empty).
 * @param props - Excalidraw's own props; `excalidrawAPI` is chained, not replaced.
 * @returns `{ root, api() }` - `root` unmounts it, `api()` is the imperative API
 *   once React has committed the first render (`null` before that).
 */
function mount(element, props) {
  const options = Object.assign({}, props || {})
  const passthrough = typeof options.excalidrawAPI === 'function' ? options.excalidrawAPI : null
  let api = null
  options.excalidrawAPI = (value) => {
    api = value
    if (passthrough !== null) passthrough(value)
  }
  const root = createRoot(element)
  root.render(React.createElement(Excalidraw, options))
  return { root, api: () => api }
}

globalThis.DSHExcalidraw = {
  version: '0.18.1',
  React,
  mount,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  getSceneVersion,
  restore,
  restoreElements,
  serializeAsJSON,
}
