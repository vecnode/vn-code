/**
 * dsh-canvas — browser half.
 *
 * Three things live here, and they are deliberately one file (no build step, the
 * pack's rule):
 *
 *   1. **The Canvas tab** — the conversation view ring's third entry, registered
 *      as `conversation.view` with the id `canvas` at `order: 20`, which puts it
 *      to the right of Trajectory (Chat is 0, Trajectory 10). It is a full-height
 *      design page: a rail of designs, an artboard on a zoom ladder that moves the
 *      LAYOUT box (never a CSS transform - this pack's rule from the image, audio,
 *      video, PDF and diagram surfaces), safe-area and node-box overlays, a live
 *      lint list, an export menu, and a source drawer whose Apply re-validates
 *      exactly like a model write.
 *   2. **The renderer**, which is NOT the tab. A canvas render needs real font
 *      metrics, which only a page has, and a design must be renderable while
 *      another conversation (or another tab) is on screen - so a plugin-level
 *      poller long-polls `GET /render-queue?session=*`, paints whatever is asked
 *      for, and posts the PNG, the measurements and the lints back. The tool call
 *      that asked is what the answer settles, which is how the MODEL sees its own
 *      design (`canvas_render` returns a path, and the model reads it with
 *      `read_image`).
 *   3. **The engine host** — it fetches `lib/engine.js` from the plugin's own
 *      route and imports it from a blob URL (the shape `dsh-pdf` uses for pdf.js
 *      and `dsh-editor` for CodeMirror), installs the vendored OFL faces, and
 *      gives the engine the two things only a browser has: a text measurer and
 *      decoded images.
 *
 * Nothing is fetched from the network: a design references the plugin's own
 * asset store or a file inside the conversation folder, both read through
 * routes that enforce their containment on the host side.
 */
/* global window, document, fetch, Image, Blob, URL, requestAnimationFrame, HTMLElement, Event */
window.__ModuleLoader__.load({
  id: 'dsh-canvas',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** The version marker shown in the toolbar, so a fresh bundle is easy to spot. */
    const PLUGIN_VERSION = '0.1.0-alpha.2'
    /** The conversation view this package adds to the chat panel's ring. */
    const VIEW_ID = 'canvas'
    /** Keep in sync with lib/index.js. */
    const API_ROOT = '/api/dsh-canvas'
    const STATE_ROUTE = API_ROOT + '/state'
    const DOCUMENT_ROUTE = API_ROOT + '/document'
    const DELETE_ROUTE = API_ROOT + '/delete'
    const PUBLISH_ROUTE = API_ROOT + '/publish'
    const ASSET_ROUTE = API_ROOT + '/asset'
    const QUEUE_ROUTE = API_ROOT + '/render-queue'
    const REPORT_ROUTE = API_ROOT + '/render-report'
    const WORKSPACE_ASSET_ROUTE = API_ROOT + '/workspace-asset'
    const ENGINE_ROUTE = API_ROOT + '/vendor/engine.js'
    /** The tool names whose conversation cards this package draws. */
    const TOOL_NAMES = ['canvas_new', 'canvas_write', 'canvas_patch', 'canvas_read', 'canvas_style', 'canvas_publish', 'canvas_delete', 'canvas_render', 'canvas_export', 'canvas_assets']
    /** The zoom ladder. `fit` is resolved from the stage size at paint time. */
    const ZOOM_STEPS = ['fit', 0.25, 0.5, 1, 2]
    /** The feed-size factor a report carries, so the model can judge a phone feed. */
    const FEED_SCALE = 0.25
    /** How long one long-poll hangs before the poller re-issues it. */
    const POLL_WAIT_MS = 20_000

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------
    const CSS = `
/* The composer floats over this view (data-conversation-composer-overlay), so the
   view draws the seam the shell would otherwise not: a hairline at the composer's
   own top edge, on the token the app's own column separators use. The clearance
   keeps the artboard's controls off the input box. */
.dsc-root{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.45 var(--dsw-font-family,inherit);--dsc-composer-clearance:calc(var(--dsh-composer-height,152px) + 16px)}
.dsc-root:after{content:"";position:absolute;left:0;right:0;bottom:var(--dsh-composer-height,152px);height:1px;background:var(--dsw-alias-border-l3);pointer-events:none;z-index:2}
.dsc-bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-height:38px}
.dsc-barGroup{display:flex;align-items:center;gap:4px}
.dsc-spacer{flex:1}
.dsc-btn{box-sizing:border-box;height:26px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.dsc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-btn:disabled{opacity:.5;cursor:default}
.dsc-btn[data-active=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dsc-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary,#4D6BFE);color:#fff;border-color:transparent}
.dsc-select{height:26px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px}
.dsc-chip{display:inline-flex;align-items:center;gap:5px;height:19px;padding:0 7px;border-radius:6px;font-size:11px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dsc-pill{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;font-size:10px;font-weight:650;letter-spacing:.02em}
.dsc-pill[data-state=drawn]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsc-pill[data-state=failed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsc-pill[data-state=stale]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.dsc-pill[data-state=pending]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.dsc-body{flex:1;display:flex;min-height:0}
.dsc-rail{flex:none;width:216px;border-right:.5px solid var(--dsw-alias-border-l3);overflow:auto;padding:8px}
.dsc-railHead{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.dsc-row{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border-radius:9px;cursor:pointer;border:.5px solid transparent}
.dsc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-row[data-selected=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3)}
.dsc-rowTitle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);min-width:0}
.dsc-rowName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-rowMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-stage{flex:1;min-width:0;min-height:0;overflow:auto;position:relative;background:repeating-conic-gradient(from 0deg,var(--dsw-alias-bg-layer-1) 0% 25%,transparent 0% 50%) 0 0/16px 16px}
.dsc-stage[data-panning=true]{cursor:grabbing}
.dsc-pad{min-width:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:28px;padding-bottom:var(--dsc-composer-clearance,168px)}
.dsc-art{position:relative;flex:none;box-shadow:0 18px 44px rgba(0,0,0,.28);border-radius:2px;overflow:hidden;cursor:grab;touch-action:none}
.dsc-art canvas{display:block;width:100%;height:100%}
.dsc-art[data-dragging=true]{cursor:grabbing}
.dsc-art[data-empty=true]{box-shadow:none}
.dsc-layers{display:flex;flex-direction:column;gap:2px;margin:0 0 10px;padding:0;list-style:none}
.dsc-layer{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);border:.5px solid transparent}
.dsc-layer:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-layer[data-selected=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsc-layerKind{flex:none;font:10px/16px var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary);text-transform:uppercase;min-width:42px}
.dsc-layerName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-layerTools{flex:none;display:flex;gap:2px;opacity:0}
.dsc-layer:hover .dsc-layerTools,.dsc-layer[data-selected=true] .dsc-layerTools{opacity:1}
.dsc-mini{width:18px;height:18px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:4px;font-size:12px;line-height:1;padding:0}
.dsc-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-mini:disabled{opacity:.35;cursor:default}
.dsc-empty{max-width:520px;text-align:center;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:12px;align-items:center}
.dsc-empty h3{margin:0;font-size:15px;color:var(--dsw-alias-label-primary)}
.dsc-empty p{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.dsc-gallery{display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;margin-top:4px}
.dsc-galleryItem{text-align:left;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:7px 8px;cursor:pointer;color:inherit;font:inherit}
.dsc-galleryItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-galleryTitle{font-size:11.5px;color:var(--dsw-alias-label-primary);display:block}
.dsc-galleryMeta{font-size:10px;color:var(--dsw-alias-label-tertiary);display:block;margin-top:2px}
.dsc-styles{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 4px}
.dsc-styleChip{display:inline-flex;align-items:center;gap:5px;padding:3px 7px 3px 5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.dsc-styleChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-styleChip[data-selected=true]{border-color:var(--dsw-alias-brand-primary,#4D6BFE);color:var(--dsw-alias-label-primary)}
.dsc-styleDots{display:inline-flex;gap:2px}
.dsc-styleDots i{width:9px;height:9px;border-radius:3px;display:block}
.dsc-styleName{white-space:nowrap}
.dsc-styleCard{display:flex;flex-direction:column;gap:4px;padding:7px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin:0 0 10px}
.dsc-styleCard strong{font-size:11.5px;color:var(--dsw-alias-label-primary)}
.dsc-styleIntent{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.45}
.dsc-styleRule{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.dsc-styleRule b{color:var(--dsw-alias-label-tertiary);font-weight:600}
.dsc-side{flex:none;width:296px;border-left:.5px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.dsc-sideHead{flex:none;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.dsc-sideBody{flex:1;min-height:0;overflow:auto;padding:8px 10px}
.dsc-lints{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsc-lint{display:flex;gap:6px;align-items:flex-start;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.dsc-lint[data-level=error]{color:var(--dsw-alias-state-error-primary)}
.dsc-lintCode{flex:none;font:10px/16px var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary);text-transform:uppercase}
.dsc-metrics{font:11px/1.6 var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;margin:0 0 10px}
.dsc-feed{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.dsc-feed canvas{border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;background:#000}
.dsc-drawer{flex:none;border-top:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;max-height:46%;min-height:0}
.dsc-drawerHead{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.06em}
.dsc-drawer textarea{flex:1;min-height:160px;resize:none;margin:0 10px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:11.5px/1.5 var(--ds-font-family-code,monospace);padding:8px}
.dsc-note{padding:6px 10px;font-size:11.5px;color:var(--dsw-alias-state-error-primary);border-top:.5px solid var(--dsw-alias-border-l2)}
.dsc-note[data-kind=info]{color:var(--dsw-alias-label-secondary)}
.dsc-card{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsc-cardPic{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:#000;overflow:hidden}
.dsc-cardPic canvas{display:block}
.dsc-cardText{min-width:0;display:flex;flex-direction:column;gap:4px}
.dsc-cardTitle{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.dsc-cardBody{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;max-height:132px;overflow:hidden}
.dsc-hidden{display:none}
`
    const CSS_TAG = 'dsh-canvas/canvas.css'
    const FONT_CSS_TAG = 'dsh-canvas/fonts.css'

    // -----------------------------------------------------------------------
    // Small utilities
    // -----------------------------------------------------------------------
    /**
     * One plugin stylesheet in the document head, added once.
     *
     * The lookup goes through `querySelector` when the document has it (every
     * browser) and falls back to walking `head.children` by the marker attribute,
     * which is what the tracked client check's stand-in document offers.
     */
    function findStyleTag(which) {
      const head = document.head
      if (!head) return null
      if (typeof head.querySelector === 'function') return head.querySelector('[data-plugin-css="' + which + '"]')
      for (const child of head.children ?? []) {
        if (child && child.dataset && child.dataset.pluginCss === which) return child
      }
      return null
    }

    function installStyles(which, css) {
      const existing = findStyleTag(which)
      if (existing) return existing
      const style = document.createElement('style')
      // Both spellings: `dataset` is how the pack's own checks read a plugin
      // stylesheet back, and the attribute is what a browser exposes to CSS.
      style.setAttribute('data-plugin-css', which)
      if (style.dataset) style.dataset.pluginCss = which
      style.textContent = css
      document.head.appendChild(style)
      return style
    }

    /** `fetch` with same-origin credentials and JSON in/out. */
    async function api(path, options) {
      const response = await fetch(path, { credentials: 'same-origin', ...(options ?? {}) })
      const text = await response.text()
      let body = null
      try {
        body = text.length > 0 ? JSON.parse(text) : null
      } catch (err) {
        body = null
      }
      if (!response.ok) {
        const failure = new Error((body && body.error && body.error.message) || 'request failed (' + response.status + ')')
        failure.code = body && body.error ? body.error.code : 'HTTP_' + response.status
        failure.status = response.status
        failure.body = body
        throw failure
      }
      return body
    }

    /** Base64 of an ArrayBuffer, by hand (no per-byte callback at 20 MB). */
    function toBase64(buffer) {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      }
      return btoa(binary)
    }

    /** Base64 of a UTF-8 string (used for the SVG export). */
    function textToBase64(text) {
      return toBase64(new TextEncoder().encode(text).buffer)
    }

    /** A Blob -> base64 promise. */
    function blobToBase64(blob) {
      return blob.arrayBuffer().then(toBase64)
    }

    // -----------------------------------------------------------------------
    // The engine (fetched once, imported from a blob URL)
    // -----------------------------------------------------------------------
    let enginePromise = null
    /**
     * The shared engine module. The route answers with `text/javascript`, and a
     * blob URL is how a module with no static imports is loaded at runtime - the
     * same shape `dsh-pdf` uses for its vendored pdf.js.
     */
    function loadEngine() {
      if (enginePromise === null) {
        enginePromise = (async () => {
          const response = await fetch(ENGINE_ROUTE + '?v=' + PLUGIN_VERSION, { credentials: 'same-origin' })
          if (!response.ok) throw new Error('the canvas engine could not be loaded (' + response.status + ')')
          const source = await response.text()
          if (!source || source.length < 1000) throw new Error('the canvas engine route answered with something too small to be the engine')
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
          try {
            return await import(/* webpackIgnore: true */ url)
          } finally {
            URL.revokeObjectURL(url)
          }
        })()
        enginePromise.catch(() => {
          // A failed load is retried on the next call rather than cached forever.
          enginePromise = null
        })
      }
      return enginePromise
    }

    /** The engine, or null (with a note) when it could not be loaded. */
    async function engineOrNull(setNote) {
      try {
        return await loadEngine()
      } catch (err) {
        if (setNote) setNote(err && err.message ? err.message : 'the canvas engine is unavailable')
        return null
      }
    }

    // -----------------------------------------------------------------------
    // Fonts
    // -----------------------------------------------------------------------
    /** Install the vendored faces once, from the URLs the state payload carries. */
    function installFonts(fonts) {
      const rules = []
      for (const [family, entry] of Object.entries(fonts ?? {})) {
        for (const [weight, meta] of Object.entries(entry.weights ?? {})) {
          rules.push(
            '@font-face{font-family:"' + family + '";font-style:normal;font-weight:' + weight +
              ';font-display:block;src:url("' + meta.url + '") format("woff2")}',
          )
        }
      }
      if (rules.length === 0) return
      const existing = findStyleTag(FONT_CSS_TAG)
      if (existing) {
        if (existing.textContent === rules.join('\n')) return
        existing.textContent = rules.join('\n')
        return
      }
      installStyles(FONT_CSS_TAG, rules.join('\n'))
    }

    /**
     * Wait until the faces a design uses are actually loaded.
     *
     * This is load-bearing: `measureText` with a font that has not loaded answers
     * with the FALLBACK face's metrics, so the first wrap of a headline would be
     * wrong and the picture would not match the export. Every family/weight a
     * design names is awaited before the layout runs.
     */
    async function ensureFonts(document_, fonts) {
      if (!document_ || !document_.fonts) return []
      const wanted = new Set()
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.kind === 'text' && (node.runs || node.text !== undefined)) {
          const role = node.family ?? (node.style === 'display' || node.style === 'title' ? 'display' : 'text')
          const family = document_.tokens.font[role]
          const size = node.size ?? document_.tokens.scale[node.style ?? 'body'] ?? 16
          const weight = node.weight ?? (node.style === 'display' || node.style === 'title' ? 700 : 400)
          if (family && family !== 'system') wanted.add(weight + ' ' + size + 'px "' + family + '"')
        }
        for (const child of node.children ?? []) walk(child)
      }
      for (const layer of document_.layers ?? []) walk(layer)
      const resolved = []
      if (typeof document.fonts === 'undefined' || wanted.size === 0) return resolved
      for (const spec of wanted) {
        try {
          await document.fonts.load(spec)
          resolved.push(spec)
        } catch (err) {
          /* a face that will not load leaves the fallback, which the report names */
        }
      }
      try {
        await document.fonts.ready
      } catch (err) {
        /* ignore */
      }
      return resolved
    }

    /** Which families actually drew: the report carries this so a fallback is visible. */
    function resolvedFamilies(document_, fonts) {
      const out = new Set()
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.kind === 'text') {
          const role = node.family ?? (node.style === 'display' || node.style === 'title' ? 'display' : 'text')
          out.add(document_.tokens.font[role] ?? 'system')
        }
        for (const child of node.children ?? []) walk(child)
      }
      for (const layer of document_.layers ?? []) walk(layer)
      const names = [...out]
      if (typeof document.fonts === 'undefined') return names
      return names.map((family) => {
        const entry = fonts ? fonts[family] : null
        if (!entry) return family
        const available = Object.keys(entry.weights ?? {}).some((weight) => {
          try {
            return document.fonts.check(weight + ' 16px "' + family + '"')
          } catch (err) {
            return true
          }
        })
        return available ? family : family + ' (fallback: ' + (typeof document.fonts.check === 'function' ? 'not loaded' : 'unknown') + ')'
      })
    }

    // -----------------------------------------------------------------------
    // Measurement
    // -----------------------------------------------------------------------
    /** A 2D context to measure with, and the measurer the engine takes. */
    function createMeasurer() {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      // The measurer is called with the engine's own font object: build the same
      // font shorthand the painters use for the real rendering.
      const measure = (text, font) => {
        context.font = (font.weight ?? 400) + ' ' + (font.size ?? 16) + 'px ' + (font.stack ?? 'sans-serif')
        return context.measureText(text).width
      }
      measure.metrics = (font) => {
        context.font = (font.weight ?? 400) + ' ' + (font.size ?? 16) + 'px ' + (font.stack ?? 'sans-serif')
        const metrics = context.measureText('Hxg')
        const ascent = metrics.fontBoundingBoxAscent
        const descent = metrics.fontBoundingBoxDescent
        if (typeof ascent === 'number' && typeof descent === 'number' && ascent + descent > 0) {
          const size = font.size ?? 16
          return { ascent: ascent / size, descent: descent / size }
        }
        return { ascent: 0.8, descent: 0.2 }
      }
      return measure
    }

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------
    /** A stored-asset name: the content hash the host writes. */
    const ASSET_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/

    /** Whether a `src` reads as a workspace-relative path. */
    function isWorkspacePath(src) {
      return typeof src === 'string' && src.length > 0 && !ASSET_NAME.test(src) && (src.includes('/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|tiff?)$/i.test(src))
    }

    /**
     * Decode one `src` into something the painter can draw, with the bytes kept
     * as base64 so an `.svg` export can inline them (an SVG rendered as an image
     * may not fetch anything).
     *
     * @returns `{ bitmap, base64, width, height, mime }` or null.
     */
    async function loadImage(src, sessionId) {
      if (typeof src !== 'string' || src.length === 0) return null
      const url = ASSET_NAME.test(src)
        ? ASSET_ROUTE + '?name=' + encodeURIComponent(src)
        : WORKSPACE_ASSET_ROUTE + '?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(src)
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) return null
      const mime = response.headers.get('content-type') || 'image/png'
      const buffer = await response.arrayBuffer()
      const base64 = toBase64(buffer)
      const blob = new Blob([buffer], { type: mime })
      let bitmap = null
      try {
        bitmap = await createImageBitmap(blob)
      } catch (err) {
        // A browser without createImageBitmap for this type falls back to an
        // <img>, which is enough for drawImage and for the SVG-once path.
        bitmap = await new Promise((resolve) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => resolve(null)
          image.src = URL.createObjectURL(blob)
        })
      }
      if (!bitmap) return null
      return { bitmap, base64, mime, width: bitmap.width, height: bitmap.height }
    }

    /** A raw SVG fragment as a drawable image (wrapped in a real <svg> root). */
    async function loadFragment(op) {
      const viewBox = op.viewBox ? op.viewBox.join(' ') : '0 0 ' + Math.max(1, op.w) + ' ' + Math.max(1, op.h)
      const inner = String(op.svg ?? '').replace(/<\?xml[^>]*\?>/g, '').trim()
      const full = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + Math.max(1, op.w) + '" height="' + Math.max(1, op.h) + '" viewBox="' + viewBox + '">' + inner + '</svg>'
      const url = 'data:image/svg+xml;base64,' + textToBase64(full)
      return new Promise((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => resolve(null)
        image.src = url
      })
    }

    // -----------------------------------------------------------------------
    // The renderer
    // -----------------------------------------------------------------------
    /**
     * Lay out and paint one document.
     *
     * @returns `{ ops, boxes, lints, metrics, images, fontSpecs, width, height }`.
     */
    async function prepareRender(engine, document_, preset, sessionId, fonts, options = {}) {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const fontSpecs = await ensureFonts(document_, fonts)
      const measurer = createMeasurer()
      // The asset table the layout needs for hug sizes, plus the decoded images.
      const images = {}
      const assets = {}
      const srcs = new Set()
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.kind === 'image' && typeof node.src === 'string') srcs.add(node.src)
        for (const child of node.children ?? []) walk(child)
      }
      for (const layer of document_.layers ?? []) walk(layer)
      for (const src of srcs) {
        const loaded = await loadImage(src, sessionId)
        if (!loaded) continue
        images[src] = loaded.bitmap
        assets[src] = { width: loaded.width, height: loaded.height }
      }
      let laid = engine.layout(document_, { measure: measurer, assets, fonts })
      // Raw SVG fragments are rasterized once, then drawn as pictures.
      for (const op of laid.ops) {
        if (op.kind !== 'svg') continue
        const image = await loadFragment(op)
        if (image) images['svg:' + op.path] = image
      }
      const imagesForLint = Object.assign({}, images)
      const lints = engine.lintLayout(laid, document_, preset, { assets, images: imagesForLint })
      const textNodes = laid.boxes.filter((entry) => entry.kind === 'text')
      const smallest = textNodes.reduce((min, entry) => {
        const size = entry.font && entry.font.size
        return typeof size === 'number' && size > 0 && size < min ? size : min
      }, Infinity)
      const metrics = {
        ops: laid.ops.length,
        boxes: laid.boxes.length,
        textNodes: textNodes.length,
        lines: laid.ops.filter((op) => op.kind === 'text').length,
        smallestType: Number.isFinite(smallest) ? smallest : null,
        families: resolvedFamilies(document_, fonts),
        ms: Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt) * 10) / 10,
      }
      if (options.withFeed) metrics.feedScale = FEED_SCALE
      return { ops: laid.ops, boxes: laid.boxes, lints, metrics, images, fontSpecs, width: laid.width, height: laid.height, warnings: laid.warnings }
    }

    /** Paint an op list into a canvas of `width x height` CSS pixels at `scale`. */
    function paintInto(engine, canvas, prepared, scale) {
      const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
      const pixelRatio = scale <= 0.5 ? 1 : dpr
      const deviceScale = scale * pixelRatio
      canvas.width = Math.max(1, Math.round(prepared.width * deviceScale))
      canvas.height = Math.max(1, Math.round(prepared.height * deviceScale))
      canvas.style.width = Math.round(prepared.width * scale) + 'px'
      canvas.style.height = Math.round(prepared.height * scale) + 'px'
      const context = canvas.getContext('2d')
      context.clearRect(0, 0, canvas.width, canvas.height)
      engine.paintCanvas(prepared.ops, context, { scale: deviceScale, images: prepared.images, assets: {} })
      return canvas
    }

    /** One canvas as a PNG (or JPEG) blob. */
    function canvasBlob(canvas, mime, quality) {
      return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the canvas produced no image'))), mime, quality)
          return
        }
        try {
          const dataUrl = canvas.toDataURL(mime, quality)
          const base64 = dataUrl.replace(/^data:[^,]*,/, '')
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          resolve(new Blob([bytes], { type: mime }))
        } catch (err) {
          reject(err)
        }
      })
    }

    /** Render a prepared design into a fresh canvas at a scale, returning the canvas. */
    async function rasterize(engine, prepared, scale) {
      const canvas = document.createElement('canvas')
      paintInto(engine, canvas, prepared, scale)
      return canvas
    }

    /** Prepare the `.svg` payload for an export: the images and the fonts inlined. */
    async function svgPayload(engine, prepared, document_, fonts, sessionId) {
      const families = prepared.metrics.families.map((entry) => String(entry).split(' ')[0])
      prepared.fontBase64 = await fontBase64(fonts, families)
      prepared.assetsBase64 = (
        await Promise.all(
          Object.keys(prepared.images)
            .filter((src) => !src.startsWith('svg:'))
            .map(async (src) => {
              const loaded = await loadImage(src, sessionId)
              return loaded ? { src, base64: loaded.base64, mime: loaded.mime } : null
            }),
        )
      ).filter(Boolean)
      return svgForPrepared(engine, prepared, document_, fonts)
    }

    /** Fetch the font files a design used, as base64 (for an SVG export). */
    async function fontBase64(fonts, families) {
      const out = {}
      for (const [family, entry] of Object.entries(fonts ?? {})) {
        if (!families.includes(family)) continue
        for (const meta of Object.values(entry.weights ?? {})) {
          try {
            const response = await fetch(meta.url, { credentials: 'same-origin' })
            if (!response.ok) continue
            out[meta.file] = toBase64(await response.arrayBuffer())
          } catch (err) {
            /* a missing face leaves the export with the fallback stack */
          }
        }
      }
      return out
    }

    // -----------------------------------------------------------------------
    // The session store
    // -----------------------------------------------------------------------
    /** One conversation's canvas state: the payload, a version counter, listeners. */
    const stores = new Map()
    function storeFor(sessionId) {
      const key = String(sessionId ?? '')
      if (!stores.has(key)) stores.set(key, { sessionId: key, state: null, error: null, loading: false, listeners: new Set(), version: 0 })
      return stores.get(key)
    }
    function notify(store) {
      store.version += 1
      for (const listener of [...store.listeners]) listener()
    }
    function applyState(store, payload) {
      store.state = payload
      store.error = null
      notify(store)
    }
    /** Load (or reload) one conversation's payload. */
    async function refresh(sessionId, { force = false } = {}) {
      const store = storeFor(sessionId)
      if (!store.sessionId) return
      if (store.loading && !force) return
      store.loading = true
      try {
        const payload = await api(STATE_ROUTE + '?session=' + encodeURIComponent(store.sessionId))
        applyState(store, payload)
      } catch (err) {
        store.error = err
        notify(store)
      } finally {
        store.loading = false
      }
    }
    /** Merge one saved design into the payload, so a save needs no round trip. */
    function mergeDesign(store, design) {
      if (!store.state || !design) return
      const designs = Array.isArray(store.state.designs) ? store.state.designs.slice() : []
      const index = designs.findIndex((entry) => entry.id === design.id)
      if (index >= 0) designs[index] = design
      else designs.push(design)
      store.state = { ...store.state, designs }
      notify(store)
    }
    /** A React hook over one conversation's payload. */
    function useCanvasStore(sessionId, { load = true } = {}) {
      const store = storeFor(sessionId)
      const [, setVersion] = useState(0)
      useEffect(() => {
        const listener = () => setVersion((value) => value + 1)
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }, [store])
      useEffect(() => {
        if (load && sessionId) refresh(sessionId)
      }, [sessionId, load])
      return { store, state: store.state, error: store.error }
    }

    // -----------------------------------------------------------------------
    // The page-level renderer
    // -----------------------------------------------------------------------
    /**
     * Answer render requests for ANY conversation.
     *
     * This runs from `apply`, not from the tab: the model may ask for a design in
     * a chat whose Canvas tab is not on screen, and the page must still paint it.
     * A design is rendered with the engine, the assets and the fonts, the PNG and
     * the feed thumbnail are encoded, the lints and measurements are computed, and
     * everything is posted back to the request that asked for it.
     */
    function startRenderer() {
      let stopped = false
      let failures = 0
      const run = async () => {
        while (!stopped) {
          try {
            const answer = await api(QUEUE_ROUTE + '?session=*&wait=' + POLL_WAIT_MS)
            failures = 0
            const request = answer && answer.request
            if (!request) continue
            await answerRequest(request)
          } catch (err) {
            failures += 1
            // A quiet exponential backoff: the page stays usable while the host
            // is away, and one failure does not become a busy loop.
            const wait = Math.min(15_000, 500 * Math.pow(2, Math.min(5, failures)))
            await new Promise((resolve) => setTimeout(resolve, wait))
          }
        }
      }
      run()
      return () => {
        stopped = true
      }
    }

    /**
     * One request, end to end: prepare, paint, encode, report.
     *
     * A failure is POSTed too - a render that could not happen is a verdict the
     * model must see, not a silence.
     */
    async function answerRequest(request) {
      const sessionId = request.session
      const base = {
        session: sessionId,
        id: request.id,
        scope: request.scope,
        revision: request.revision,
        requestId: request.requestId,
        purpose: request.purpose,
        format: request.format,
        scale: request.scale,
        name: request.name,
        target: request.target,
      }
      try {
        const engine = await loadEngine()
        const store = storeFor(sessionId)
        if (!store.state) await refresh(sessionId, { force: true })
        const fonts = (store.state && store.state.fonts) || {}
        installFonts(fonts)
        const preset = store.state && store.state.presets ? store.state.presets[request.preset] ?? null : null
        const prepared = await prepareRender(engine, request.document, preset, sessionId, fonts)
        if (request.purpose === 'export') {
          if (request.format === 'svg') {
            const svg = await svgPayload(engine, prepared, request.document, fonts, sessionId)
            await api(REPORT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...base, ok: true, svg, lints: prepared.lints, metrics: prepared.metrics, fonts: prepared.metrics.families }),
            })
            return
          }
          const canvas = await rasterize(engine, prepared, request.scale === 2 ? 2 : 1)
          const mime = request.format === 'jpg' ? 'image/jpeg' : 'image/png'
          const blob = await canvasBlob(canvas, mime, request.format === 'jpg' ? 0.92 : undefined)
          const png = await blobToBase64(blob)
          await api(REPORT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...base,
              ok: true,
              png,
              width: canvas.width,
              height: canvas.height,
              lints: prepared.lints,
              metrics: prepared.metrics,
              fonts: prepared.metrics.families,
            }),
          })
          return
        }
        // A report: the full render at the requested scale, plus the feed thumbnail.
        const canvas = await rasterize(engine, prepared, request.scale ?? 1)
        const full = await blobToBase64(await canvasBlob(canvas, 'image/png'))
        const feedCanvas = await rasterize(engine, prepared, FEED_SCALE)
        const feed = await blobToBase64(await canvasBlob(feedCanvas, 'image/png'))
        await api(REPORT_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...base,
            ok: true,
            png: full,
            feed,
            feedScale: FEED_SCALE,
            width: canvas.width,
            height: canvas.height,
            lints: prepared.lints,
            metrics: prepared.metrics,
            fonts: prepared.metrics.families,
          }),
        })
        const storeNow = storeFor(sessionId)
        refresh(sessionId, { force: true }).catch(() => {})
        void storeNow
      } catch (err) {
        try {
          await api(REPORT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...base, ok: false, error: err && err.message ? err.message : 'the renderer failed' }),
          })
        } catch (nested) {
          /* the host is unreachable: the tool call will time out and say so */
        }
      }
    }

    /** The SVG text for a prepared design, with images and fonts embedded. */
    async function svgForPrepared(engine, prepared, document_, fonts) {
      const inline = new Map()
      for (const entry of prepared.assetsBase64 ?? []) {
        inline.set(entry.src, 'data:' + entry.mime + ';base64,' + entry.base64)
      }
      return engine.toSvg(prepared.ops, document_, {
        embed: (src) => (inline.has(String(src)) ? inline.get(String(src)) : null),
        fontFaceCss: (family) => {
          const entry = fonts ? fonts[family] : null
          if (!entry || !prepared.fontBase64) return null
          const blocks = []
          for (const [weight, meta] of Object.entries(entry.weights ?? {})) {
            const base64 = prepared.fontBase64[meta.file]
            if (!base64) continue
            blocks.push('    @font-face{font-family:"' + family + '";font-weight:' + weight + ';src:url(data:font/woff2;base64,' + base64 + ') format("woff2")}')
          }
          return blocks.length > 0 ? blocks.join('\n') : null
        },
      })
    }

    // -----------------------------------------------------------------------
    // Small components
    // -----------------------------------------------------------------------
    /** A render verdict pill. */
    function Pill({ verification }) {
      const state = verification ? verification.state : 'pending'
      return h('span', { className: 'dsc-pill', 'data-state': state, title: verification && verification.error ? verification.error : state }, state)
    }

    /** One lint line. */
    function LintLine({ lint }) {
      return h(
        'li',
        { className: 'dsc-lint', 'data-level': lint.level },
        h('span', { className: 'dsc-lintCode' }, lint.code),
        h('span', null, lint.message),
      )
    }

    /** A toolbar button. */
    function Btn({ onClick, children, active, disabled, kind, title }) {
      return h(
        'button',
        { type: 'button', className: 'dsc-btn', onClick, disabled: disabled === true, 'data-active': active === true ? 'true' : 'false', 'data-kind': kind, title },
        children,
      )
    }

    // -----------------------------------------------------------------------
    // The artboard
    // -----------------------------------------------------------------------
    /**
     * The design on a zoom ladder. The zoom moves the LAYOUT box - a canvas sized
     * `width * zoom` inside a scrollable stage - never a CSS transform, so a
     * zoomed design stays scrollable to its edge (this pack's rule from the image,
     * audio, video, PDF and diagram surfaces).
     */
    function Artboard({ engine, document_, preset, sessionId, fonts, zoom, overlays, onLints, onMetrics, onPrepared, selectedPath, onSelect, onMove, feedRef }) {
      const canvasRef = useRef(null)
      const preparedRef = useRef(null)
      const [preparedVersion, setPreparedVersion] = useState(0)
      const [fit, setFit] = useState(1)
      const [note, setNote] = useState('')
      const wrapRef = useRef(null)

      // A "fit" zoom is measured from the stage, and re-measured when it resizes.
      useEffect(() => {
        if (zoom !== 'fit') return undefined
        const element = wrapRef.current
        if (!element) return undefined
        const measure = () => {
          const box = element.getBoundingClientRect()
          const scale = Math.min((box.width - 56) / document_.canvas.width, (box.height - 56) / document_.canvas.height, 1)
          setFit(scale > 0.05 ? scale : 0.05)
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [zoom, document_.canvas.width, document_.canvas.height])

      const scale = zoom === 'fit' ? fit : zoom

      // Prepare (fonts, assets, layout) only when the DOCUMENT changes; painting is
      // a separate effect so dragging the zoom ladder never re-wraps the type.
      useEffect(() => {
        let cancelled = false
        const run = async () => {
          try {
            const prepared = await prepareRender(engine, document_, preset, sessionId, fonts)
            if (cancelled) return
            preparedRef.current = prepared
            setNote('')
            setPreparedVersion((value) => value + 1)
            if (onLints) onLints(prepared.lints)
            if (onMetrics) onMetrics(prepared.metrics)
            if (onPrepared) onPrepared(prepared)
          } catch (err) {
            if (!cancelled) setNote(err && err.message ? err.message : 'the design could not be laid out')
          }
        }
        run()
        return () => {
          cancelled = true
        }
      }, [engine, document_, preset, sessionId, fonts, onLints, onMetrics, onPrepared])

      // Paint at the current zoom (and into the feed thumbnail) whenever either
      // the prepared design or the zoom changes.
      useEffect(() => {
        const prepared = preparedRef.current
        if (!prepared) return
        if (canvasRef.current) paintInto(engine, canvasRef.current, prepared, zoom === 'fit' ? fit : zoom)
        if (feedRef && feedRef.current) paintInto(engine, feedRef.current, prepared, FEED_SCALE)
      }, [engine, preparedVersion, zoom, fit, feedRef])

      // Safety areas, node boxes and THE SELECTION are drawn as an SVG overlay in
      // DESIGN pixels scaled by the same factor, so they line up at any zoom.
      const overlay = overlays && (overlays.safe || overlays.boxes)
      const prepared = preparedRef.current

      /**
       * Pointer down on the artboard: pick the topmost MOVABLE node under the
       * cursor and, if it moves before the pointer comes up, hand the delta back
       * in DESIGN pixels.
       *
       * Hit testing uses the boxes the layout already produced, so what the person
       * clicks is what they can see. A node is movable when it (or its parent
       * chain) can carry an `x`/`y`: a top-level layer always can, and a child of a
       * frame that names x/y is already out of the flow. A flow child CAN still be
       * dragged - setting x/y is exactly what takes it out of the flow - but only
       * the nodes the report already shows as absolute are offered first, so a
       * stray drag inside a text block does not silently unfix its layout.
       */
      const onArtPointerDown = (event) => {
        const current = preparedRef.current
        if (!current || event.button !== 0) return
        const rect = event.currentTarget.getBoundingClientRect()
        const pointX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * document_.canvas.width
        const pointY = ((event.clientY - rect.top) / Math.max(1, rect.height)) * document_.canvas.height
        const layers = new Set((document_.layers ?? []).map((node, index) => 'layers.' + index))
        const candidates = current.boxes.filter((entry) => {
          const box = entry.box
          return pointX >= box.x && pointX <= box.x + box.w && pointY >= box.y && pointY <= box.y + box.h
        })
        // Topmost first: the last painted box that contains the point, preferring a
        // node that is already absolute (a top-level layer, or a child with x/y).
        const chosen = [...candidates].reverse().find((entry) => layers.has(entry.path) || isAbsolutePath(document_, entry.path)) ?? [...candidates].reverse()[0]
        if (!chosen) return
        if (onSelect) onSelect(chosen.path)
        const startX = event.clientX
        const startY = event.clientY
        let moved = false
        const element = event.currentTarget
        const move = (moveEvent) => {
          const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * document_.canvas.width
          const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * document_.canvas.height
          if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return
          moved = true
          element.setAttribute('data-dragging', 'true')
          moveEvent.preventDefault()
        }
        const up = (upEvent) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          element.removeAttribute('data-dragging')
          if (!moved) return
          const dx = ((upEvent.clientX - startX) / Math.max(1, rect.width)) * document_.canvas.width
          const dy = ((upEvent.clientY - startY) / Math.max(1, rect.height)) * document_.canvas.height
          if (onMove) onMove(chosen.path, Math.round(dx), Math.round(dy))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      return h(
        'div',
        { className: 'dsc-pad', ref: wrapRef, 'data-canvas-stage': 'true' },
        h(
          'div',
          {
            className: 'dsc-art',
            'data-canvas-artboard': document_.preset ?? 'freeform',
            onPointerDown: onArtPointerDown,
            style: { width: Math.max(1, Math.round(document_.canvas.width * scale)) + 'px', height: Math.max(1, Math.round(document_.canvas.height * scale)) + 'px' },
          },
          h('canvas', { ref: canvasRef, 'data-canvas-art': 'true' }),
          (overlay || selectedPath) && prepared
            ? h(Overlay, {
                prepared,
                preset,
                width: document_.canvas.width,
                height: document_.canvas.height,
                scale,
                showSafe: Boolean(overlays && overlays.safe),
                showBoxes: Boolean(overlays && overlays.boxes),
                selectedPath: selectedPath ?? null,
              })
            : null,
        ),
        note ? h('div', { className: 'dsc-note' }, note) : null,
      )
    }

    /** Whether a node path names something the document already positions with x/y. */
    function isAbsolutePath(document_, path) {
      const node = nodeAtPath(document_, path)
      return Boolean(node && typeof node === 'object' && (node.x !== undefined || node.y !== undefined))
    }

    /** The node at a document path, or null. */
    function nodeAtPath(document_, path) {
      const segments = String(path ?? '').split('.')
      let cursor = document_
      for (const segment of segments) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') return null
        cursor = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment]
        if (cursor === undefined) return null
      }
      return cursor ?? null
    }

    /** A layer's readable name: its id, else a snippet of its text, else its kind. */
    function layerLabel(node, path) {
      if (!node) return String(path)
      if (typeof node.id === 'string' && node.id.length > 0) return node.id
      if (typeof node.text === 'string' && node.text.length > 0) return '"' + node.text.slice(0, 28) + '"'
      if (Array.isArray(node.runs) && node.runs.length > 0) return '"' + node.runs.map((run) => run.text).join('').slice(0, 28) + '"'
      if (typeof node.src === 'string') return node.src
      return node.shape ?? node.style ?? node.kind
    }

    /** Every node of a document as a flat list of `{ path, node, depth }`, in paint order. */
    function layerTree(document_) {
      const rows = []
      const walk = (node, path, depth) => {
        rows.push({ path, node, depth })
        for (let index = 0; index < (node.children ?? []).length; index += 1) walk(node.children[index], path + '.children.' + index, depth + 1)
      }
      const layers = document_ && Array.isArray(document_.layers) ? document_.layers : []
      for (let index = 0; index < layers.length; index += 1) walk(layers[index], 'layers.' + index, 0)
      return rows
    }

    /** The safe-area, node-box and SELECTION overlay, in design pixels. */
    function Overlay({ prepared, preset, width, height, scale, showSafe, showBoxes, selectedPath }) {
      const children = []
      if (showSafe && preset && Array.isArray(preset.safeAreas)) {
        for (const area of preset.safeAreas) {
          children.push(
            h('rect', {
              key: 'area-' + area.label,
              x: area.x,
              y: area.y,
              width: area.w,
              height: area.h,
              fill: area.level === 'keep-out' ? 'rgba(240,68,82,0.13)' : 'rgba(77,107,254,0.10)',
              stroke: area.level === 'keep-out' ? 'rgba(240,68,82,0.65)' : 'rgba(77,107,254,0.55)',
              strokeWidth: 1,
              strokeDasharray: area.level === 'keep-out' ? '6 4' : '2 4',
            }),
          )
        }
      }
      if (showBoxes) {
        for (const box of prepared.boxes) {
          children.push(
            h('rect', {
              key: 'box-' + box.path,
              x: box.box.x,
              y: box.box.y,
              width: box.box.w,
              height: box.box.h,
              fill: 'none',
              stroke: box.kind === 'text' ? 'rgba(120,220,160,0.75)' : 'rgba(255,255,255,0.35)',
              strokeWidth: 1,
            }),
          )
        }
      }
      // The selection is always drawn when something is selected: it is the only
      // way to know which layer a drag will move.
      if (selectedPath) {
        const entry = prepared.boxes.find((box) => box.path === selectedPath)
        if (entry) {
          const handle = Math.max(4, Math.round(6 / Math.max(0.2, scale)))
          children.push(
            h('rect', {
              key: 'selection',
              'data-canvas-selection': selectedPath,
              x: entry.box.x - 1,
              y: entry.box.y - 1,
              width: entry.box.w + 2,
              height: entry.box.h + 2,
              fill: 'none',
              stroke: 'rgba(77,107,254,0.95)',
              strokeWidth: Math.max(1, Math.round(1.5 / Math.max(0.2, scale))),
            }),
          )
          for (const [cx, cy] of [
            [entry.box.x, entry.box.y],
            [entry.box.x + entry.box.w, entry.box.y],
            [entry.box.x, entry.box.y + entry.box.h],
            [entry.box.x + entry.box.w, entry.box.y + entry.box.h],
          ]) {
            children.push(h('rect', { key: 'handle-' + cx + '-' + cy, x: cx - handle / 2, y: cy - handle / 2, width: handle, height: handle, fill: 'rgba(77,107,254,0.95)' }))
          }
        }
      }
      return h(
        'svg',
        {
          'data-canvas-overlay': 'true',
          viewBox: '0 0 ' + width + ' ' + height,
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' },
        },
        children,
      )
    }

    // -----------------------------------------------------------------------
    // The Canvas view
    // -----------------------------------------------------------------------
    /**
     * The tab itself. It owns no renderer: the page-level poller does the
     * rendering for the model, and this draws the same design for the person -
     * plus the source drawer, the overlays, the lints and the export menu.
     */
    function CanvasView(props) {
      const sessionId = props.canvasSession ?? props.sessionId ?? null
      const { state, error } = useCanvasStore(sessionId)
      const [engine, setEngine] = useState(null)
      const [engineNote, setEngineNote] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [zoom, setZoom] = useState('fit')
      const [overlays, setOverlays] = useState({ safe: true, boxes: false })
      const [drawer, setDrawer] = useState(false)
      const [draft, setDraft] = useState('')
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      const [lints, setLints] = useState(null)
      const [metrics, setMetrics] = useState(null)
      const [newOpen, setNewOpen] = useState(false)
      /** The node the layer list and the drag both address, as a document path. */
      const [selectedPath, setSelectedPath] = useState(null)
      const feedRef = useRef(null)
      const stageRef = useRef(null)

      useEffect(() => {
        installStyles(CSS_TAG, CSS)
      }, [])

      useEffect(() => {
        let cancelled = false
        engineOrNull(setEngineNote).then((loaded) => {
          if (!cancelled && loaded) setEngine(loaded)
        })
        return () => {
          cancelled = true
        }
      }, [])

      useEffect(() => {
        if (state && state.fonts) installFonts(state.fonts)
      }, [state])

      const designs = (state && state.designs) || []
      const selected = designs.find((entry) => entry.id === selectedId) ?? designs[0] ?? null
      useEffect(() => {
        if (selected && selected.id !== selectedId) setSelectedId(selected.id)
      }, [selected, selectedId])

      // Keep the drawer in step with the selection (and with the agent's writes).
      const selectedRevision = selected ? selected.revision : null
      const selectedDocument = selected ? selected.document : null
      useEffect(() => {
        if (!drawer) return
        if (selectedDocument) setDraft(JSON.stringify(selectedDocument, null, 2))
      }, [drawer, selectedRevision, selectedDocument])

      // The selection belongs to ONE design: switching designs clears it.
      useEffect(() => {
        setSelectedPath(null)
      }, [selectedId])

      const preset = selected && state && state.presets ? state.presets[selected.preset] ?? null : null

      /**
       * Send pointer operations to the host.
       *
       * The SAME route the source drawer and the agent's `canvas_write` go
       * through, so a drag is validated exactly like a model write and cannot put
       * a document the validator would refuse into the store. `by: 'person'`
       * marks who did it.
       */
      const applyOps = useCallback(
        async (ops, label) => {
          if (!selected || !sessionId || !Array.isArray(ops) || ops.length === 0) return null
          setBusy(true)
          setNote(null)
          try {
            const answer = await api(DOCUMENT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, id: selected.id, scope: selected.scope, ops, by: 'person' }),
            })
            if (answer && answer.design) mergeDesign(storeFor(sessionId), answer.design)
            setNote({ kind: 'info', text: (label ?? 'Edited') + ' (revision ' + (answer && answer.design ? answer.design.revision : '?') + ')' })
            return answer
          } catch (err) {
            const problems = err && err.body && Array.isArray(err.body.problems) ? err.body.problems : null
            setNote({ kind: 'error', text: problems ? problems.map((entry) => entry.message).join('\n') : err && err.message ? err.message : 'the edit was refused' })
            return null
          } finally {
            setBusy(false)
          }
        },
        [selected, sessionId],
      )

      /** A drag on the artboard: move one node by a delta in design pixels. */
      const moveLayer = useCallback(
        (path, dx, dy) => {
          if (!selected || (!dx && !dy)) return
          const boxes = lastPreparedRef.current
          const entry = boxes ? boxes.boxes.find((box) => box.path === path) : null
          const node = nodeAtPath(selected.document, path)
          if (!node) return
          // A node that is positioned by x/y keeps its own values; one that is in a
          // frame's flow is given the position it already has on screen, which is
          // exactly what takes it out of the flow (a documented rule of the
          // language, not a side effect).
          const startX = typeof node.x === 'number' ? node.x : entry ? Math.round(entry.box.x) : 0
          const startY = typeof node.y === 'number' ? node.y : entry ? Math.round(entry.box.y) : 0
          applyOps(
            [
              { op: 'set', at: path + '.x', value: Math.max(0, Math.round(startX + dx)) },
              { op: 'set', at: path + '.y', value: Math.max(0, Math.round(startY + dy)) },
            ],
            'Moved ' + layerLabel(node, path),
          )
        },
        [selected, applyOps],
      )

      /** Move one node one step up or down inside its own array. */
      const reorderLayer = useCallback(
        (path, direction) => {
          if (!selected) return
          const segments = String(path).split('.')
          const index = Number(segments[segments.length - 1])
          const parentPath = segments.slice(0, -1).join('.')
          const target = index + (direction === 'up' ? 1 : -1)
          if (target < 0) return
          const node = nodeAtPath(selected.document, path)
          if (!node) return
          applyOps(
            [
              { op: 'remove', at: path },
              { op: 'insert', at: parentPath + '.' + target, value: node },
            ],
            'Reordered the layers',
          )
        },
        [selected, applyOps],
      )

      // Panning: a drag on the stage moves its own scroll offsets.
      const onPointerDown = useCallback((event) => {
        const stage = event.currentTarget
        if (event.button !== 0) return
        if (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight) return
        const startX = event.clientX
        const startY = event.clientY
        const left = stage.scrollLeft
        const top = stage.scrollTop
        stage.setAttribute('data-panning', 'true')
        const move = (moveEvent) => {
          stage.scrollLeft = left - (moveEvent.clientX - startX)
          stage.scrollTop = top - (moveEvent.clientY - startY)
        }
        const up = () => {
          stage.removeAttribute('data-panning')
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }, [])

      /** Save what the person edited in the drawer, through the same validator. */
      const applyDraft = useCallback(async () => {
        if (!selected || !sessionId) return
        setBusy(true)
        setNote(null)
        try {
          const parsed = JSON.parse(draft)
          const answer = await api(DOCUMENT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, id: selected.id, document: parsed, by: 'person' }),
          })
          if (answer && answer.design) mergeDesign(storeFor(sessionId), answer.design)
          setNote({ kind: 'info', text: 'Saved revision ' + (answer && answer.design ? answer.design.revision : '?') + '.' })
        } catch (err) {
          const problems = err && err.body && Array.isArray(err.body.problems) ? err.body.problems : null
          setNote({ kind: 'error', text: problems ? problems.map((entry) => (entry.path ? entry.path + ': ' : '') + entry.message).join('\n') : err && err.message ? err.message : 'could not save' })
        } finally {
          setBusy(false)
        }
      }, [draft, selected, sessionId])

      /** Apply a look to the selected design - the same transform `canvas_style` runs. */
      const restyle = useCallback(
        async (styleId) => {
          if (!selected || !sessionId || !styleId) return
          setBusy(true)
          setNote(null)
          try {
            const answer = await api(DOCUMENT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, id: selected.id, scope: selected.scope, style: styleId, by: 'person' }),
            })
            if (answer && answer.design) mergeDesign(storeFor(sessionId), answer.design)
            setNote({ kind: 'info', text: 'Applied the ' + styleId + ' style (revision ' + (answer && answer.design ? answer.design.revision : '?') + ') - nothing moved.' })
          } catch (err) {
            setNote({ kind: 'error', text: err && err.message ? err.message : 'the style could not be applied' })
          } finally {
            setBusy(false)
          }
        },
        [selected, sessionId],
      )

      /** Start a new design from a preset + archetype. */
      const createDesign = useCallback(
        async (presetId, archetypeId, styleId) => {
          if (!sessionId) return
          setBusy(true)
          setNote(null)
          setNewOpen(false)
          try {
            const body = { session: sessionId, document: null, preset: presetId, archetype: archetypeId, style: styleId ?? null }
            // The host's own starter (and archetype) live behind the tools, so the
            // tab asks for the same thing a model asks for: a document, validated.
            const answer = await api(DOCUMENT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            if (answer && answer.design) {
              mergeDesign(storeFor(sessionId), answer.design)
              setSelectedId(answer.design.id)
            }
          } catch (err) {
            setNote({ kind: 'error', text: err && err.message ? err.message : 'could not create a design' })
          } finally {
            setBusy(false)
          }
        },
        [sessionId],
      )

      /** Export the selected design: the host writes the file. */
      const exportDesign = useCallback(
        async (format, scale, target) => {
          if (!engine || !selected || !sessionId) return
          setBusy(true)
          setNote(null)
          try {
            const prepared = await prepareRender(engine, selected.document, preset, sessionId, (state && state.fonts) || {})
            let payload = { session: sessionId, id: selected.id, scope: selected.scope, revision: selected.revision, purpose: 'export', format, scale, target, name: selected.id }
            if (format === 'svg') {
              payload = { ...payload, ok: true, svg: await svgPayload(engine, prepared, selected.document, (state && state.fonts) || {}, sessionId) }
            } else {
              const canvas = await rasterize(engine, prepared, scale === 2 ? 2 : 1)
              const mime = format === 'jpg' ? 'image/jpeg' : 'image/png'
              const blob = await canvasBlob(canvas, mime, format === 'jpg' ? 0.92 : undefined)
              payload = { ...payload, ok: true, png: await blobToBase64(blob), width: canvas.width, height: canvas.height }
            }
            const answer = await api(REPORT_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
            setNote({ kind: 'info', text: 'Wrote ' + (answer && answer.path ? answer.path : 'the file') })
            refresh(sessionId, { force: true }).catch(() => {})
          } catch (err) {
            setNote({ kind: 'error', text: err && err.message ? err.message : 'the export failed' })
          } finally {
            setBusy(false)
          }
        },
        [engine, selected, sessionId, preset, state],
      )

      const onLints = useCallback((value) => setLints(value), [])
      const onMetrics = useCallback((value) => setMetrics(value), [])
      /** The last laid-out design, kept so a drag can read the box it started on. */
      const lastPreparedRef = useRef(null)
      const onPrepared = useCallback((value) => {
        lastPreparedRef.current = value
      }, [])

      if (!sessionId) {
        return h('div', { className: 'dsc-root', 'data-conversation-composer-overlay': '', 'data-dsh-canvas-view': 'true' },
          h('div', { className: 'dsc-pad' }, h('div', { className: 'dsc-empty' }, h('h3', null, 'Canvas'), h('p', null, 'Open a conversation to design in it.'))),
        )
      }

      const toolbar = h(
        'div',
        { className: 'dsc-bar', 'data-canvas-bar': 'true' },
        h('span', { className: 'dsc-chip', title: 'dsh-canvas version' }, 'Canvas ' + PLUGIN_VERSION),
        selected ? h('span', { className: 'dsc-chip' }, selected.preset ?? 'free-form') : null,
        (state && state.styles && state.styles.length > 0)
          ? h('select', {
              className: 'dsc-select',
              'data-canvas-style-picker': 'true',
              title: 'The look this design carries - applying one never moves anything',
              value: (selected && selected.document && selected.document.style) || '',
              disabled: busy || !selected,
              onChange: (event) => restyle(event.target.value),
            },
              h('option', { value: '' }, 'No style'),
              (state.styles || []).map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
            )
          : null,
        selected ? h(Pill, { verification: selected.verification }) : null,
        h('span', { className: 'dsc-spacer' }),
        h('div', { className: 'dsc-barGroup' },
          h('span', { className: 'dsc-chip' }, 'Zoom'),
          ...ZOOM_STEPS.map((step) => h(Btn, { key: 'zoom-' + step, active: zoom === step, onClick: () => setZoom(step), title: step === 'fit' ? 'Fit to the pane' : Math.round(step * 100) + '%' }, step === 'fit' ? 'Fit' : Math.round(step * 100) + '%')),
        ),
        h('div', { className: 'dsc-barGroup' },
          h(Btn, { active: overlays.safe, onClick: () => setOverlays((value) => ({ ...value, safe: !value.safe })), title: 'Show the preset\u2019s safe and keep-out areas' }, 'Safe areas'),
          h(Btn, { active: overlays.boxes, onClick: () => setOverlays((value) => ({ ...value, boxes: !value.boxes })), title: 'Show every node\u2019s box' }, 'Boxes'),
        ),
        h('div', { className: 'dsc-barGroup' },
          h(Btn, { onClick: () => exportDesign('png', 1, 'desktop'), disabled: busy || !selected, kind: 'primary' }, 'Export PNG'),
          h(Btn, { onClick: () => exportDesign('png', 2, 'desktop'), disabled: busy || !selected, title: 'Twice the pixels, same composition' }, '2\u00d7'),
          h(Btn, { onClick: () => exportDesign('svg', 1, 'desktop'), disabled: busy || !selected, title: 'Vector, with the bundled fonts embedded' }, 'SVG'),
          h(Btn, { onClick: () => exportDesign('png', 1, 'workspace'), disabled: busy || !selected, title: 'Write into the conversation folder' }, 'To workspace'),
        ),
        h(Btn, { active: drawer, onClick: () => setDrawer((value) => !value), title: 'Edit the document' }, 'Source'),
        h(Btn, { onClick: () => refresh(sessionId, { force: true }) }, 'Reload'),
      )

      const rail = h(
        'aside',
        { className: 'dsc-rail', 'data-canvas-rail': 'true' },
        h('div', { className: 'dsc-railHead' }, h('span', null, 'Designs'), h(Btn, { onClick: () => setNewOpen((value) => !value), title: 'Start a new design' }, '+ New')),
        newOpen ? h(NewGallery, { state, onCreate: createDesign, busy }) : null,
        designs.length === 0 && !newOpen
          ? h('p', { className: 'dsc-rowMeta', style: { padding: '4px 2px' } }, 'Nothing here yet. Press + New, or ask the agent for a banner.')
          : null,
        designs.map((entry) =>
          h(
            'div',
            {
              key: entry.id,
              className: 'dsc-row',
              'data-selected': entry.id === (selected && selected.id) ? 'true' : 'false',
              onClick: () => setSelectedId(entry.id),
              title: entry.title,
            },
            h('div', { className: 'dsc-rowTitle' }, h('span', { className: 'dsc-rowName' }, entry.title), h(Pill, { verification: entry.verification })),
            h('div', { className: 'dsc-rowMeta' }, (entry.preset ?? 'free-form') + ' · rev ' + entry.revision + ' · ' + entry.warnings + ' warn'),
          ),
        ),
      )

      const stage = h(
        'div',
        { className: 'dsc-stage', ref: stageRef, onPointerDown, 'data-canvas-stage-scroll': 'true' },
        selected && engine
          ? h(Artboard, {
              engine,
              document_: selected.document,
              preset,
              sessionId,
              fonts: (state && state.fonts) || {},
              zoom,
              overlays,
              onLints,
              onMetrics,
              onPrepared,
              selectedPath,
              onSelect: setSelectedPath,
              onMove: moveLayer,
              feedRef,
            })
          : h('div', { className: 'dsc-pad' }, h(EmptyState, { engineNote, error, state, onCreate: createDesign, onOpenNew: () => setNewOpen(true) })),
      )

      const layers = selected ? layerTree(selected.document) : []
      const styleLibrary = (state && state.styles) || []
      const currentStyleId = selected && selected.document ? selected.document.style ?? null : null
      const currentStyle = styleLibrary.find((entry) => entry.id === currentStyleId) ?? null
      const side = h(
        'aside',
        { className: 'dsc-side', 'data-canvas-side': 'true' },
        h('div', { className: 'dsc-sideHead' }, h('span', null, 'Layers'), h('span', null, selected ? layers.length + ' · rev ' + selected.revision : '')),
        h('div', { className: 'dsc-sideBody' },
          // THE STYLE this design carries: its name, what it is for, and the rules
          // the person and the model are both held to. Coming from the same pack the
          // transform reads, so the advice cannot drift from the look.
          currentStyle
            ? h('div', { className: 'dsc-styleCard', 'data-canvas-style-card': currentStyle.id },
                h('strong', null, currentStyle.name),
                h('span', { className: 'dsc-styleIntent' }, currentStyle.intent),
                ...(currentStyle.do || []).slice(0, 2).map((rule, index) => h('span', { key: 'do-' + index, className: 'dsc-styleRule' }, h('b', null, 'Do: '), rule)),
                ...(currentStyle.dont || []).slice(0, 2).map((rule, index) => h('span', { key: 'dont-' + index, className: 'dsc-styleRule' }, h('b', null, 'Don\u2019t: '), rule)),
                ...(currentStyle.gates || []).slice(0, 2).map((gate, index) => h('span', { key: 'gate-' + index, className: 'dsc-styleRule' }, h('b', null, 'Gate: '), gate)),
              )
            : styleLibrary.length > 0
              ? h('p', { className: 'dsc-rowMeta' }, 'No style yet - pick one above, or ask the agent for a look.')
              : null,
          // THE LAYER LIST: every node of the design, in paint order, nested. A row
          // selects the node the drag will move; the arrows reorder it inside its
          // own array; the values are the design's own, in design pixels.
          layers.length > 0
            ? h('ul', { className: 'dsc-layers', 'data-canvas-layers': 'true' },
                layers.map((row) =>
                  h('li', {
                    key: row.path,
                    className: 'dsc-layer',
                    'data-selected': row.path === selectedPath ? 'true' : 'false',
                    'data-layer-path': row.path,
                    style: { paddingLeft: 6 + row.depth * 10 + 'px' },
                    onClick: () => setSelectedPath(row.path),
                    title: row.path,
                  },
                    h('span', { className: 'dsc-layerKind' }, row.node.kind),
                    h('span', { className: 'dsc-layerName' }, layerLabel(row.node, row.path)),
                    h('span', { className: 'dsc-layerTools' },
                      h('button', { type: 'button', className: 'dsc-mini', title: 'Move up in this array', disabled: busy || row.path.endsWith('.0'), onClick: (event) => { event.stopPropagation(); reorderLayer(row.path, 'up') } }, '↑'),
                      h('button', { type: 'button', className: 'dsc-mini', title: 'Move down in this array', disabled: busy, onClick: (event) => { event.stopPropagation(); reorderLayer(row.path, 'down') } }, '↓'),
                    ),
                  ),
                ),
              )
            : h('p', { className: 'dsc-rowMeta' }, selected ? 'This design has no layers yet.' : 'No design selected.'),
          h('p', { className: 'dsc-rowMeta', style: { margin: '10px 0 6px' } }, 'Drag a layer on the artboard to move it (a node inside a frame\u2019s flow is given the position it has, which takes it out of the flow).'),
          h('div', { className: 'dsc-sideHead', style: { borderTop: '.5px solid var(--dsw-alias-border-l2)', margin: '0 -10px', padding: '8px 10px' } }, h('span', null, 'Report'), h('span', null, metrics ? '' : 'laying out…')),
          metrics ? h('pre', { className: 'dsc-metrics' }, metricsText(metrics)) : h('p', { className: 'dsc-rowMeta' }, 'No measurements yet.'),
          selected && selected.verification && selected.verification.path
            ? h('p', { className: 'dsc-rowMeta', title: selected.verification.path }, 'Last picture: ' + shortPath(selected.verification.path))
            : null,
          h('div', { className: 'dsc-feed' }, h('span', { className: 'dsc-rowMeta' }, 'Feed size (' + Math.round(FEED_SCALE * 100) + '%)'), h('canvas', { ref: feedRef, 'data-canvas-feed': 'true' })),
          h('p', { className: 'dsc-rowMeta', style: { marginTop: '10px' } }, 'Lints for this revision:'),
          lints && lints.length > 0
            ? h('ul', { className: 'dsc-lints' }, lints.map((lint, index) => h(LintLine, { key: lint.code + index, lint })))
            : h('p', { className: 'dsc-rowMeta' }, lints ? 'None.' : 'Laying out…'),
        ),
      )

      return h(
        'div',
        { className: 'dsc-root', 'data-conversation-composer-overlay': '', 'data-dsh-canvas-view': 'true', 'data-canvas-version': PLUGIN_VERSION },
        toolbar,
        h('div', { className: 'dsc-body' }, rail, stage, side),
        drawer && selected
          ? h(
              'div',
              { className: 'dsc-drawer', 'data-canvas-drawer': 'true' },
              h('div', { className: 'dsc-drawerHead' }, h('span', null, 'Document (canonical JSON)'), h('span', { className: 'dsc-spacer' }),
                h(Btn, { onClick: applyDraft, disabled: busy, kind: 'primary' }, 'Apply'),
                h(Btn, { onClick: () => setDraft(JSON.stringify(selected.document, null, 2)) }, 'Reset'),
              ),
              h('textarea', { value: draft, spellCheck: false, onChange: (event) => setDraft(event.target.value), 'data-canvas-source': 'true' }),
            )
          : null,
        note ? h('div', { className: 'dsc-note', 'data-kind': note.kind }, note.text) : null,
        engineNote ? h('div', { className: 'dsc-note', 'data-kind': 'info' }, engineNote) : null,
      )
    }

    /** The feed thumbnail's canvas lives in the side panel and is painted by the
     * artboard's paint effect, so the person sees exactly what the model is told
     * to judge legibility on. */
    function metricsText(metrics) {
      const parts = []
      if (typeof metrics.ops === 'number') parts.push('ops      ' + metrics.ops)
      if (typeof metrics.boxes === 'number') parts.push('nodes    ' + metrics.boxes)
      if (typeof metrics.textNodes === 'number') parts.push('text     ' + metrics.textNodes)
      if (typeof metrics.lines === 'number') parts.push('lines    ' + metrics.lines)
      if (typeof metrics.smallestType === 'number') parts.push('smallest ' + metrics.smallestType + 'px')
      if (Array.isArray(metrics.families)) parts.push('families ' + metrics.families.join(', '))
      if (typeof metrics.ms === 'number') parts.push('layout   ' + metrics.ms + 'ms')
      return parts.join('\n')
    }

    /** The tail of a long absolute path. */
    function shortPath(value) {
      const text = String(value ?? '')
      const parts = text.split(/[\\/]/)
      return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : text
    }

    /** The "+ New" gallery: presets crossed with archetypes. */
    function NewGallery({ state, onCreate, busy }) {
      const presets = state && state.presets ? Object.values(state.presets) : []
      const archetypes = (state && state.archetypes) || []
      const styles = (state && state.styles) || []
      const [presetId, setPresetId] = useState(presets.length > 0 ? presets[0].id : null)
      const [styleId, setStyleId] = useState(null)
      useEffect(() => {
        if (presetId === null && presets.length > 0) setPresetId(presets[0].id)
      }, [presetId, presets])
      const matching = archetypes.filter((entry) => !presetId || entry.presets.includes(presetId))
      const chosenStyle = styles.find((entry) => entry.id === styleId) ?? null
      return h(
        'div',
        { 'data-canvas-new': 'true' },
        h('select', { className: 'dsc-select', value: presetId ?? '', onChange: (event) => setPresetId(event.target.value), style: { width: '100%', marginBottom: '6px' } },
          presets.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label + ' \u00b7 ' + entry.width + '\u00d7' + entry.height)),
        ),
        // THE LOOK LIBRARY: a composition is WHICH design, a style is HOW it looks.
        // They are independent, so a banner can be started in any genre and
        // re-styled later without moving a single element.
        styles.length > 0
          ? h('div', { className: 'dsc-styles', 'data-canvas-styles': 'true' },
              styles.map((entry) =>
                h('button', {
                  key: entry.id,
                  type: 'button',
                  className: 'dsc-styleChip',
                  'data-selected': entry.id === styleId ? 'true' : 'false',
                  title: entry.intent,
                  onClick: () => setStyleId(entry.id === styleId ? null : entry.id),
                },
                  h('span', { className: 'dsc-styleDots' }, (entry.swatch.colours || []).slice(0, 4).map((colour, index) => h('i', { key: colour + index, style: { background: colour } }))),
                  h('span', { className: 'dsc-styleName' }, entry.name),
                ),
              ),
            )
          : null,
        chosenStyle ? h('p', { className: 'dsc-rowMeta', style: { margin: '6px 0' } }, chosenStyle.intent) : null,
        h('div', { className: 'dsc-gallery' },
          h('button', { type: 'button', className: 'dsc-galleryItem', disabled: busy, onClick: () => onCreate(presetId, null, styleId) },
            h('span', { className: 'dsc-galleryTitle' }, 'Blank starter'),
            h('span', { className: 'dsc-galleryMeta' }, chosenStyle ? chosenStyle.name + ' starter' : 'Mesh + your headline'),
          ),
          matching.map((entry) =>
            h('button', { key: entry.id, type: 'button', className: 'dsc-galleryItem', disabled: busy, onClick: () => onCreate(presetId, entry.id, styleId), title: entry.description },
              h('span', { className: 'dsc-galleryTitle' }, entry.title),
              h('span', { className: 'dsc-galleryMeta' }, entry.presets.length + ' preset(s)'),
            ),
          ),
        ),
      )
    }

    /** The empty state: what Canvas is, and the two ways to start. */
    function EmptyState({ engineNote, error, state, onCreate, onOpenNew }) {
      const presets = state && state.presets ? Object.values(state.presets) : []
      return h(
        'div',
        { className: 'dsc-empty', 'data-canvas-empty': 'true' },
        h('h3', null, 'Canvas'),
        h('p', null, 'A design page the agent drives. Ask for a GitHub social preview, a LinkedIn banner or a poster, or start one yourself - the agent writes the same document the drawer shows, and the browser renders it here.'),
        h('p', null, engineNote || (error ? String(error.message ?? error) : null) || 'Pick a destination to start:'),
        presets.length > 0
          ? h('div', { className: 'dsc-gallery' },
              presets.slice(0, 6).map((preset) =>
                h('button', { key: preset.id, type: 'button', className: 'dsc-galleryItem', onClick: () => onCreate(preset.id, null) },
                  h('span', { className: 'dsc-galleryTitle' }, preset.label),
                  h('span', { className: 'dsc-galleryMeta' }, preset.width + '\u00d7' + preset.height),
                ),
              ),
            )
          : h(Btn, { onClick: onOpenNew }, 'New design'),
      )
    }

    // -----------------------------------------------------------------------
    // The conversation card
    // -----------------------------------------------------------------------
    /** Whether one conversation block is a settled tool call. */
    function isSettled(block) {
      return Boolean(block && block.kind === 'tool-result')
    }

    /** The host's own view of the design a settled call produced, or null. */
    function viewOfBlock(block) {
      const meta = block && block.meta
      if (!meta || typeof meta !== 'object') return null
      return typeof meta.id === 'string' && meta.id.length > 0 ? meta : null
    }

    /** Parse a tool call's arguments, running or settled. */
    function argsOf(block) {
      const raw = block && 'kind' in block ? block.call && block.call.argsRaw : block && block.argsRaw
      if (typeof raw !== 'string' || raw.length === 0) return null
      try {
        return JSON.parse(raw)
      } catch (err) {
        return null
      }
    }

    /**
     * The conversation card for the nine canvas tools: what the call was about,
     * the design as it stands (drawn small, from the same engine), the verdict,
     * and the text the host returned.
     */
    function ToolCard(props) {
      const sessionId = props.sessionId ?? null
      const block = props.block
      const args = argsOf(block)
      const settled = isSettled(block)
      const meta = settled ? viewOfBlock(block) : null
      const id = (args && args.id) || (meta && meta.id) || null
      const { state } = useCanvasStore(sessionId, { load: settled })
      const [engine, setEngine] = useState(null)
      const canvasRef = useRef(null)
      const entry = state && Array.isArray(state.designs) ? state.designs.find((design) => design.id === id) ?? null : null

      useEffect(() => {
        if (!settled) return undefined
        let cancelled = false
        engineOrNull(null).then((loaded) => {
          if (!cancelled && loaded) setEngine(loaded)
        })
        return () => {
          cancelled = true
        }
      }, [settled])

      useEffect(() => {
        if (!engine || !entry || !canvasRef.current) return undefined
        let cancelled = false
        const preset = state && state.presets ? state.presets[entry.preset] ?? null : null
        prepareRender(engine, entry.document, preset, sessionId, (state && state.fonts) || {})
          .then((prepared) => {
            if (cancelled || !canvasRef.current) return
            const maxWidth = 240
            const scale = Math.min(1, maxWidth / prepared.width)
            paintInto(engine, canvasRef.current, prepared, scale)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [engine, entry, sessionId, state])

      const content = settled && block.content ? flattenContent(block.content) : runningText(props.toolName, args)
      const state_ = entry ? entry.verification.state : meta ? meta.state : 'pending'
      return h(
        'div',
        { className: 'dsc-card', 'data-canvas-card': props.toolName },
        h('div', { className: 'dsc-cardPic' }, h('canvas', { ref: canvasRef, 'data-canvas-card-pic': 'true' })),
        h('div', { className: 'dsc-cardText' },
          h('div', { className: 'dsc-cardTitle' }, h('strong', null, titleOf(props.toolName, args, entry, meta)), h('span', { className: 'dsc-pill', 'data-state': state_ }, state_)),
          h('div', { className: 'dsc-cardBody' }, content),
        ),
      )
    }

    /** The text of a settled tool result. */
    function flattenContent(content) {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .map((part) => (part && part.type === 'text' ? part.text : typeof part === 'string' ? part : ''))
          .filter(Boolean)
          .join('\n')
      }
      return content ? String(content) : ''
    }

    /** The card title for a running call. */
    function titleOf(toolName, args, entry, meta) {
      const verb = String(toolName ?? 'canvas').replace(/^canvas_/, '')
      const name = (entry && entry.title) || (meta && meta.title) || (args && args.id) || (args && args.preset) || ''
      return 'Canvas ' + verb + (name ? ' · ' + name : '')
    }

    /** What a running call is doing. */
    function runningText(toolName, args) {
      if (toolName === 'canvas_render') return 'Rendering in the browser…'
      if (toolName === 'canvas_export') return 'Writing the file…'
      if (toolName === 'canvas_new') return 'Starting a design' + (args && args.preset ? ' for ' + args.preset : '') + '…'
      return 'Working on the design…'
    }

    // -----------------------------------------------------------------------
    // The plugin entry
    // -----------------------------------------------------------------------
    /** Services the activation waits for: the slot registry. */
    const inject = ['slots']

    function apply(ctx) {
      try {
        installStyles(CSS_TAG, CSS)
        // 1. The tab: the conversation view ring's third entry, to the right of
        //    Trajectory (Chat 0, Trajectory 10). The `inject` face is how a view
        //    learns its session: a conversation view receives no `sessionId` prop,
        //    only the value its own registration's inject function returns.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: VIEW_ID,
                  order: 20,
                  label: () => 'Canvas',
                  inject: (sessionId) => ({ canvasSession: sessionId }),
                },
                CanvasView,
              ),
            ),
          'dsh-canvas: canvas view',
        )
        // 2. One conversation card per tool, keyed on the wire tool name.
        for (const toolName of TOOL_NAMES) {
          ctx.effect(
            () =>
              ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, ToolCard)),
            'dsh-canvas: ' + toolName + ' card',
          )
        }
        // 3. The page-level renderer: it answers render requests for any
        //    conversation, whether or not this tab is on screen.
        ctx.effect(() => startRenderer(), 'dsh-canvas: renderer')
        ctx.logger?.debug?.('[dsh-canvas] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-canvas] activation failed', err)
        ctx.logger?.warn?.('[dsh-canvas] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-canvas'
    exports.inject = inject
    exports.apply = apply
    // The pure-ish half a check can reach: the route names, the view identity and
    // the helpers whose behaviour is otherwise only visible in a browser.
    exports.__internals = {
      VIEW_ID,
      PLUGIN_VERSION,
      ROUTES: { STATE_ROUTE, DOCUMENT_ROUTE, DELETE_ROUTE, PUBLISH_ROUTE, ASSET_ROUTE, QUEUE_ROUTE, REPORT_ROUTE, WORKSPACE_ASSET_ROUTE, ENGINE_ROUTE },
      TOOL_NAMES,
      ZOOM_STEPS,
      FEED_SCALE,
      CSS,
      ASSET_NAME,
      isWorkspacePath,
      isSettled,
      viewOfBlock,
      argsOf,
      flattenContent,
      metricsText,
      shortPath,
      nodeAtPath,
      layerTree,
      layerLabel,
      isAbsolutePath,
      toBase64,
      textToBase64,
      createMeasurer,
      ensureFonts,
      prepareRender,
      paintInto,
      CanvasView,
      ToolCard,
      startRenderer,
    }
    return module.exports
  },
})
