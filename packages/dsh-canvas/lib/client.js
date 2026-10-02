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
    const PLUGIN_VERSION = '0.1.0-alpha.10'
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
    const TOOL_NAMES = ['canvas_new', 'canvas_write', 'canvas_patch', 'canvas_read', 'canvas_style', 'canvas_set', 'canvas_publish', 'canvas_delete', 'canvas_render', 'canvas_export', 'canvas_assets']
    /** The zoom ladder. `fit` is resolved from the stage size at paint time. */
    const ZOOM_STEPS = ['fit', 0.25, 0.5, 1, 2]
    /** The feed-size factor a report carries, so the model can judge a phone feed. */
    const FEED_SCALE = 0.25
    /** How close to an edge, in SCREEN pixels, a handle is grabbed. */
    const HANDLE_HIT = 9
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
.dsc-bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-height:38px;flex-wrap:nowrap;overflow:hidden}
.dsc-barGroup{display:flex;align-items:center;gap:4px;flex:none}
/* THE EXPORT MENU. A native <details> so the open/closed state, the click anywhere
   else and Escape are the browser's, not a listener this file has to own - and so a
   row that starts an async export can keep the menu open until the write lands. */
.dsc-menu{position:relative;flex:none}
.dsc-menu>summary{list-style:none;cursor:pointer;user-select:none;white-space:nowrap}
.dsc-menu>summary::-webkit-details-marker{display:none}
.dsc-menu[open]>summary{background:var(--dsw-alias-interactive-bg-active)}
/* The panel has to clear every column of the app's own furniture - the composer seat
   is 7 (9 with a menu open), the frame's overlay layer 20, the sidebar's fixed
   controls 30 - because the canvas view is a box INSIDE that layout. 1000 is the
   app's own modal-root layer: a menu belongs above the layout it drops out of, and
   still below the toasts and portals that are meant to interrupt anything. */
.dsc-menuPanel{position:absolute;right:0;top:calc(100% + 6px);z-index:1000;min-width:236px;max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.28)}
.dsc-menuItem{display:flex;flex-direction:column;gap:1px;align-items:flex-start;width:100%;text-align:left;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dsc-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsc-menuItem:disabled{opacity:.5;cursor:default}
.dsc-menuItem[data-active=true]{background:var(--dsw-alias-interactive-bg-active)}
.dsc-menuLabel{font-size:12px}
.dsc-menuHint{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* THE TRANSFORM CONTROLS. A nudge pad is a cross of four arrows because that is the
   gesture a person already knows, and every control here writes through the same
   document route the drag does - so a button press and a drag cannot disagree. */
.dsc-nudgeRow{display:flex;align-items:center;gap:4px}
.dsc-nudgeRow button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:26px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;padding:0}
.dsc-nudgeRow button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-nudgeRow button:disabled{opacity:.4;cursor:default}
.dsc-row2{display:flex;align-items:center;gap:6px;min-width:0}
.dsc-row2>*{min-width:0}
.dsc-fieldLabel{flex:none;width:52px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsc-num{width:66px;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:0 6px}
.dsc-slider{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary,#4D6BFE)}
.dsc-swatches{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.dsc-swatch{width:20px;height:20px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);cursor:pointer;padding:0}
.dsc-swatch[data-active=true]{outline:1.5px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:1px}
.dsc-colorInput{width:26px;height:24px;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;cursor:pointer}
.dsc-spacer{flex:1}
.dsc-btn{box-sizing:border-box;height:26px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.dsc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-btn:disabled{opacity:.5;cursor:default}
.dsc-btn[data-active=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dsc-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary,#4D6BFE);color:#fff;border-color:transparent}
.dsc-btn[data-kind=primary][aria-disabled=true]{opacity:.5;cursor:default}
.dsc-select{height:26px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px}
.dsc-chip{display:inline-flex;align-items:center;gap:5px;height:19px;padding:0 7px;border-radius:6px;font-size:11px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dsc-pill{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;font-size:10px;font-weight:650;letter-spacing:.02em}
.dsc-pill[data-state=drawn]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsc-pill[data-state=failed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsc-pill[data-state=stale]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.dsc-pill[data-state=pending]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.dsc-body{flex:1;display:flex;min-height:0;overflow:hidden}
.dsc-rail{flex:none;width:216px;border-right:.5px solid var(--dsw-alias-border-l3);overflow:auto;padding:8px}
.dsc-railHead{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.dsc-row{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border-radius:9px;cursor:pointer;border:.5px solid transparent}
.dsc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-row[data-selected=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3)}
.dsc-rowTitle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);min-width:0}
.dsc-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The delete control is quiet until the row is worth acting on, and the armed row is
   marked as a question rather than as a selection. */
.dsc-rowDelete{flex:none;opacity:0;width:20px;height:20px;font-size:14px}
.dsc-row:hover .dsc-rowDelete,.dsc-row[data-selected=true] .dsc-rowDelete{opacity:1}
.dsc-rowDelete:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsc-rowConfirm{flex:none;display:inline-flex;gap:4px;align-items:center}
.dsc-rowConfirm .dsc-mini{width:auto;padding:0 7px;height:20px;font-size:11px;border:.5px solid var(--dsw-alias-border-l3)}
.dsc-danger{color:var(--dsw-alias-state-error-primary)}
.dsc-row[data-armed=true]{border-color:var(--dsw-alias-state-error-primary)}
.dsc-rowMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-stage{flex:1;min-width:0;min-height:0;overflow:auto;position:relative;background:repeating-conic-gradient(from 0deg,var(--dsw-alias-bg-layer-1) 0% 25%,transparent 0% 50%) 0 0/16px 16px}
.dsc-stage[data-panning=true]{cursor:grabbing}
/* THE PAGE: a 22px RULER gutter on the top and the left, the artboard in the corner
   they meet at. The gutter is a grid track rather than padding so the rig is one box
   the stage can centre and scroll - and because the gutter is the ONLY horizontal
   inset on the left, design x=0 lands on the artboard's own left edge, which is what
   makes the origin marker the origin. */
/* THE BOTTOM INSET IS THE CLEARANCE PLUS A GAP. The clearance is measured TO the
   composer's top edge, so reserving exactly it leaves the artboard touching the input
   box - which is what "glued together" means. The page adds its own 10px on top, and
   the same 10px inset on the other three sides keeps the ruler gutters off the frame. */
.dsc-pad{min-width:100%;min-height:100%;display:grid;grid-template-columns:22px 1fr;grid-template-rows:22px 1fr;align-items:stretch;justify-items:stretch;gap:0;padding:10px 10px calc(var(--dsc-composer-clearance,168px) + 10px) 10px}
.dsc-rig{grid-column:2;grid-row:2;position:relative;justify-self:center;align-self:center}
.dsc-padEmpty{grid-column:1/-1;grid-row:1/-1;display:flex;align-items:center;justify-content:center}
/* THE RULERS. They live in the stage, not the rig, so they stay on screen while a
   zoomed design is panned - and they are LABELLED in DESIGN pixels, which is the one
   coordinate system the document and the transform controls both speak. */
.dsc-axis{position:absolute;background:var(--dsw-alias-bg-layer-1);z-index:3;pointer-events:auto}
.dsc-axisTop{top:0;height:22px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsc-axisLeft{left:0;width:22px;border-right:.5px solid var(--dsw-alias-border-l3)}
.dsc-axisTick{position:absolute;background:var(--dsw-alias-border-l3);pointer-events:none}
.dsc-axisTop .dsc-axisTick{bottom:0;width:1px;height:6px}
.dsc-axisLeft .dsc-axisTick{right:0;height:1px;width:6px}
.dsc-axisLabel{position:absolute;font:9px/1 var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary);pointer-events:none;white-space:nowrap}
.dsc-axisTop .dsc-axisLabel{top:3px;transform:translateX(-50%)}
.dsc-axisLeft .dsc-axisLabel{left:3px;transform:translateY(-50%)}
.dsc-axisCorner{position:absolute;left:0;top:0;width:22px;height:22px;background:var(--dsw-alias-bg-layer-1);border-right:.5px solid var(--dsw-alias-border-l3);border-bottom:.5px solid var(--dsw-alias-border-l3);z-index:4}
.dsc-art{position:relative;box-shadow:0 18px 44px rgba(0,0,0,.28);border-radius:2px;overflow:hidden;cursor:grab;touch-action:none}
.dsc-art canvas{display:block;width:100%;height:100%}
.dsc-art[data-dragging=move]{cursor:grabbing}
.dsc-art[data-dragging=resize]{cursor:nwse-resize}
.dsc-art[data-empty=true]{box-shadow:none}
/* The ORIGIN MARKER: the design's own (0, 0), drawn on the artboard's top-left corner
   so a layer's x/y means the same thing on screen as it does in the document. */
.dsc-origin{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2}
.dsc-originX{position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--dsw-alias-brand-primary,#4D6BFE);opacity:.5}
.dsc-originY{position:absolute;top:0;left:0;right:0;height:1px;background:var(--dsw-alias-brand-primary,#4D6BFE);opacity:.5}
.dsc-originDot{position:absolute;left:-3px;top:-3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4D6BFE);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base)}
.dsc-layers{display:flex;flex-direction:column;gap:2px;margin:0 0 10px;padding:0;list-style:none}
.dsc-layer{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);border:.5px solid transparent}
.dsc-layer:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-layer[data-selected=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsc-layerKind{flex:none;font:9.5px/16px var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary);text-transform:uppercase;width:30px;overflow:hidden}
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
.dsc-sideHead{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
/* THE PANE SWITCHER. The bar holds two jobs that have nothing to do with each
   other - SHAPING the design (the look it carries, its layers, its lints) and
   AUDITING it (the feed thumbnail, the last picture) - and one scroll column for
   both meant a design with forty layers pushed the rest of the bar out of sight. */
.dsc-sideTabs{flex:none;display:flex;gap:4px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsc-sideTab{flex:1;height:24px;display:inline-flex;align-items:center;justify-content:center;border:.5px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer}
.dsc-sideTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-sideTab[data-active=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
/* One pane, one flex column, min-height:0 at every level: scroll always belongs to
   a NAMED block (.dsc-paneScroll for the audit pane, .dsc-layersScroll for the
   list inside the shaping pane), never to the pane, so a long list scrolls inside
   its own section and the sections under it keep their place instead of being
   pushed down the bar. */
.dsc-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.dsc-paneScroll{flex:1;min-height:0;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:10px}
.dsc-section{flex:none;display:flex;flex-direction:column;gap:6px;min-height:0}
.dsc-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.dsc-section[data-grow=true]{flex:1;padding:8px 10px 0}
.dsc-section[data-grow=true] .dsc-layersScroll{flex:1}
.dsc-layersScroll{min-height:88px;max-height:52vh;overflow:auto;margin:0 -2px;padding:0 2px}
.dsc-lints{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsc-lint{display:flex;gap:6px;align-items:flex-start;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.dsc-lint[data-level=error]{color:var(--dsw-alias-state-error-primary)}
.dsc-lintCode{flex:none;font:10px/16px var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary);text-transform:uppercase}
/* THE DRAWER IS AN OVERLAY, NOT A ROW. It used to be a flex sibling under the body,
   which meant opening it SHRANK the body and re-centred the artboard - and it opened
   at a height the composer sits on top of, so "Source" looked like a button that did
   nothing. It now floats over the BOTTOM of the canvas column, between the artboard
   and the composer, where it can be read while the design stays where it was. */
.dsc-drawer{position:absolute;left:216px;right:296px;bottom:var(--dsh-composer-height,152px);height:min(42%,320px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px 10px 0 0;z-index:6;box-shadow:0 -14px 34px rgba(0,0,0,.24)}
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
/* The Excalidraw surface (the preview mode). It is an OVERLAY on purpose: the
   design surface underneath stays mounted and untouched, so switching back is a
   state change and not a reload of anything, and this file never has to
   restructure the tab's own tree for a surface that is still being proved. */
.dsc-excalidraw{position:absolute;inset:38px 0 0 0;z-index:5;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff)}
.dsc-excalidrawHost{flex:1;min-height:0;position:relative}
.dsc-excalidrawNote{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
`
    const CSS_TAG = 'dsh-canvas/canvas.css'
    const FONT_CSS_TAG = 'dsh-canvas/fonts.css'
    /** The vendored Excalidraw surface's two artifacts, and where its assets come from. */
    const EXCALIDRAW_JS_ROUTE = '/api/dsh-canvas/vendor/excalidraw.js'
    const EXCALIDRAW_CSS_ROUTE = '/api/dsh-canvas/vendor/excalidraw.css'
    /**
     * Excalidraw builds its own runtime asset URLs as `<base> + 'fonts/…'` and
     * `<base> + 'locales/…'`, and reads the global below ONCE. Those routes do not
     * exist yet (VERSION.json's `unshipped` says so), so the fetches 404 and the
     * editor falls back to the faces its bundle already carries - which is
     * measured, not hoped for: the spike rendered text before any font was served.
     * The prefix is still set, because the day those routes exist this line is the
     * only thing that has to be true.
     */
    const EXCALIDRAW_ASSET_PATH = '/api/dsh-canvas/vendor/'

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
    // The vendored Excalidraw surface
    // -----------------------------------------------------------------------
    let excalidrawPromise = null

    /**
     * The vendored Excalidraw surface, fetched once and left on the page.
     *
     * A CLASSIC SCRIPT, not a module: the artifact is one iife bundle that leaves
     * `globalThis.DSHExcalidraw` behind (it carries its own React, because
     * Excalidraw takes React as a peer and a script tag cannot reach the shell's
     * module table), so a `<script>` element is exactly the loader it wants - no
     * blob URL, no import map, no bare specifiers. The stylesheet goes in first:
     * Excalidraw is unusable without it (`--color-primary` and every layout rule
     * live there), and a flash of unstyled editor is what loading it second looks
     * like.
     *
     * A failed load is NOT cached: the promise is dropped so the next attempt can
     * succeed, the same bargain `loadEngine` makes.
     */
    function loadExcalidraw() {
      if (excalidrawPromise === null) {
        excalidrawPromise = new Promise((resolve, reject) => {
          if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
            reject(new Error('this surface needs a document'))
            return
          }
          if (findStyleTag('dsh-canvas/excalidraw.css') === null) {
            const link = document.createElement('link')
            link.setAttribute('rel', 'stylesheet')
            link.setAttribute('data-plugin-css', 'dsh-canvas/excalidraw.css')
            link.setAttribute('href', EXCALIDRAW_CSS_ROUTE + '?v=' + PLUGIN_VERSION)
            document.head.appendChild(link)
          }
          const script = document.createElement('script')
          script.setAttribute('src', EXCALIDRAW_JS_ROUTE + '?v=' + PLUGIN_VERSION)
          script.setAttribute('data-plugin-script', 'dsh-canvas/excalidraw.js')
          script.addEventListener('load', () => {
            const surface = window.DSHExcalidraw
            if (surface === undefined || surface === null || typeof surface.mount !== 'function') {
              reject(new Error('the Excalidraw route answered, but nothing registered a surface'))
              return
            }
            // Read by Excalidraw once, before the first mount.
            window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH
            resolve(surface)
          })
          script.addEventListener('error', () => {
            reject(new Error('the Excalidraw surface could not be loaded (' + EXCALIDRAW_JS_ROUTE + ')'))
          })
          document.head.appendChild(script)
        })
        excalidrawPromise.catch(() => {
          excalidrawPromise = null
        })
      }
      return excalidrawPromise
    }

    /**
     * The Excalidraw preview: the vendored editor, mounted in the pane.
     *
     * It is a PREVIEW and the surface says so in one line rather than pretending
     * to be the finished tab: the design document is not the scene yet, the agent
     * tools still write the pack's own language, and the assets Excalidraw reaches
     * for at runtime (fonts, locales) are not vendored. What it proves is the part
     * that cannot be proved by reading: that the artifact loads from this
     * package's route, that it mounts in the real pane, and that its imperative
     * API answers.
     */
    function ExcalidrawSurface(props) {
      const hostRef = useRef(null)
      const [note, setNote] = useState('Loading the Excalidraw surface\u2026')
      const [ready, setReady] = useState(false)
      useEffect(() => {
        let live = true
        let mounted = null
        loadExcalidraw()
          .then((surface) => {
            if (!live || hostRef.current === null) return
            const host = hostRef.current
            mounted = surface.mount(host, {
              theme: 'light',
              excalidrawAPI: (api) => {
                if (!live) return
                const elements = typeof api.getSceneElements === 'function' ? api.getSceneElements().length : 0
                setNote('Excalidraw ' + String(surface.version) + ' is live \u00b7 ' + String(elements) + ' element(s) \u00b7 ' + (typeof api.updateScene === 'function' ? 'the scene API answers' : 'no scene API'))
              },
            })
            setReady(true)
          })
          .catch((err) => {
            if (live) setNote(err && err.message ? err.message : 'the Excalidraw surface could not be loaded')
          })
        return () => {
          live = false
          if (mounted !== null && mounted.root && typeof mounted.root.unmount === 'function') {
            try {
              mounted.root.unmount()
            } catch (err) {
              /* already gone */
            }
            if (hostRef.current !== null) hostRef.current.innerHTML = ''
          }
        }
      }, [])
      return h(
        'div',
        { className: 'dsc-excalidraw', 'data-canvas-excalidraw': ready ? 'ready' : 'loading' },
        h('div', { className: 'dsc-excalidrawHost', 'data-canvas-excalidraw-host': 'true', ref: hostRef }),
        h('div', { className: 'dsc-excalidrawNote' }, h('span', { 'data-canvas-excalidraw-note': 'true' }, note)),
      )
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

    /**
     * Paint an op list into a canvas of `width x height` DESIGN pixels at `scale`.
     *
     * The device pixel ratio belongs to the DISPLAY and to nothing else. On screen
     * it is what makes a 1px hairline a hairline rather than a grey smear, so the
     * artboard renders at `scale * devicePixelRatio` and is sized back down with
     * CSS. A FILE must be exactly what the preset promises - a GitHub social preview
     * is 1280x640 and its `@2x` is 2560x1280 - so the export and the render report
     * pass `forDisplay: false`, because otherwise a 135%-scaled Windows display
     * silently writes a 1728x864 banner (measured, on this machine).
     */
    function paintInto(engine, canvas, prepared, scale, options = {}) {
      const forDisplay = options.forDisplay !== false
      const dpr = forDisplay ? Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1) : 1
      const pixelRatio = forDisplay && scale > 0.5 ? dpr : 1
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

    /** A data URL's bytes, as a Blob. The second encoder, used when the first balks. */
    function blobFromDataUrl(dataUrl, mime) {
      const base64 = String(dataUrl).replace(/^data:[^,]*,/, '')
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new Blob([bytes], { type: mime })
    }

    /**
     * One canvas as a PNG (or JPEG) blob.
     *
     * TWO ENCODERS, because the first one can decline: `toBlob` is asynchronous and a
     * browser may answer `null` for it - measured in headless Chrome at 1600x900 with
     * 200 nodes on the canvas, while `toDataURL` on the very same canvas encodes
     * fine. An export that died on "the canvas produced no image" when a synchronous
     * encoder was sitting right there is the kind of failure the person cannot act
     * on, so `toBlob` is tried, and its REFUSAL (not only its absence) falls through
     * to the data URL.
     */
    function canvasBlob(canvas, mime, quality) {
      const viaDataUrl = () => {
        try {
          return Promise.resolve(blobFromDataUrl(canvas.toDataURL(mime, quality), mime))
        } catch (err) {
          return Promise.reject(err)
        }
      }
      if (typeof canvas.toBlob !== 'function') return viaDataUrl()
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), mime, quality)
      }).then((blob) => (blob ? blob : viaDataUrl()))
    }

    /** Render a prepared design into a fresh canvas at a scale, returning the canvas. */
    async function rasterize(engine, prepared, scale) {
      const canvas = document.createElement('canvas')
      // A FILE, not a display: exact design pixels times the scale, no device ratio.
      paintInto(engine, canvas, prepared, scale, { forDisplay: false })
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
    /** Drop one design from a conversation's payload, without a round trip. */
    function removeDesign(store, designId) {
      if (!store.state || !Array.isArray(store.state.designs)) return
      store.state = { ...store.state, designs: store.state.designs.filter((entry) => entry.id !== designId) }
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
    function Artboard({ engine, document_, preset, sessionId, fonts, zoom, overlays, onLints, onMetrics, onPrepared, selectedPath, onSelect, onDeselect, onMove, onResize, triggerSelect }) {
      const canvasRef = useRef(null)
      const preparedRef = useRef(null)
      const [preparedVersion, setPreparedVersion] = useState(0)
      const [fit, setFit] = useState(1)
      const [note, setNote] = useState('')
      const wrapRef = useRef(null)
      const rigRef = useRef(null)
      /** True from pointer down to pointer up: a hover must not repaint the cursor mid-drag. */
      const draggingRef = useRef(false)

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

      // Paint at the current zoom whenever either the prepared design or the zoom
      // changes. There is no second canvas any more: the quarter-scale feed thumbnail
      // that used to live in the side panel showed nothing the artboard was not
      // already showing, and the model's own 25% feed is produced by the RENDERER,
      // not by this component.
      useEffect(() => {
        const prepared = preparedRef.current
        if (!prepared) return
        if (canvasRef.current) paintInto(engine, canvasRef.current, prepared, zoom === 'fit' ? fit : zoom)
      }, [engine, preparedVersion, zoom, fit])

      // Safety areas, node boxes and THE SELECTION are drawn as an SVG overlay in
      // DESIGN pixels scaled by the same factor, so they line up at any zoom.
      const overlay = overlays && (overlays.safe || overlays.boxes)
      const prepared = preparedRef.current

      /**
       * Which edge of the selection is under a point: the box the overlay drew, the
       * point the pointer is at, the HANDLE_HIT tolerance in design pixels, and the
       * handles that box actually carries. All four are read here, in the same units,
       * for the drag AND for the hover cursor - so the gesture a person gets is
       * always the gesture the cursor promised.
       */
      const edgesFor = (entry, pointX, pointY, tolerance) => (entry ? edgesAt(entry.box, pointX, pointY, tolerance, handlesFor(entry)) : null)

      /** An element's rect, and the HANDLE_HIT tolerance in design pixels for it. */
      const toleranceFor = (element) => {
        const rect = element.getBoundingClientRect()
        return {
          rect,
          tolerance: { x: (HANDLE_HIT / Math.max(1, rect.width)) * document_.canvas.width, y: (HANDLE_HIT / Math.max(1, rect.height)) * document_.canvas.height },
        }
      }

      /** A pointer event, in the design's own pixels. */
      const pointIn = (event, rect) => ({
        x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * document_.canvas.width,
        y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * document_.canvas.height,
      })

      /**
       * Pointer down on the artboard. A HANDLE of the current selection wins over
       * everything: dragging it RESIZES that node. Anywhere else, the topmost movable
       * node under the cursor is picked and dragging it MOVES the node, and the delta
       * is handed back in DESIGN pixels.
       *
       * THE GESTURE IS DECIDED ONCE, ON POINTER DOWN, and it stays that gesture for
       * the whole drag: a drag that began on a handle can never become a move, and a
       * drag that began on a layer can never become a resize. The pointer is CAPTURED
       * for the length of the drag, so releasing it outside the artboard - or outside
       * the window - still ends the gesture exactly once.
       *
       * Hit testing uses the boxes the layout already produced, so what the person
       * clicks is what they can see. A node is movable when it (or its parent chain)
       * can carry an `x`/`y`: a top-level layer always can, and a child of a frame
       * that names x/y is already out of the flow. A flow child CAN still be dragged
       * - setting x/y is exactly what takes it out of the flow - but only the nodes
       * the report already shows as absolute are offered first, so a stray drag inside
       * a text block does not silently unfix its layout.
       */
      const onArtPointerDown = (event) => {
        const current = preparedRef.current
        if (!current || event.button !== 0) return
        const element = event.currentTarget
        const { rect, tolerance } = toleranceFor(element)
        const point = pointIn(event, rect)
        const layers = new Set((document_.layers ?? []).map((node, index) => 'layers.' + index))
        // THE SELECTION'S OWN HANDLES FIRST.
        const selectedEntry = selectedPath ? current.boxes.find((entry) => entry.path === selectedPath) : null
        const handle = edgesFor(selectedEntry, point.x, point.y, tolerance)
        const candidates = current.boxes.filter((entry) => {
          const box = entry.box
          return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
        })
        // Topmost first: the last painted box that contains the point, preferring a
        // node that is already absolute (a top-level layer, or a child with x/y).
        const chosen = handle ? selectedEntry : [...candidates].reverse().find((entry) => layers.has(entry.path) || isAbsolutePath(document_, entry.path)) ?? [...candidates].reverse()[0]
        // A CLICK ON NOTHING DE-SELECTS. The artboard is a finite rectangle inside a
        // larger stage, so "outside the selection" is a place a person can aim at
        // deliberately, and a selection that can only be replaced by another layer is
        // a selection with no way out.
        if (!chosen) {
          if (!handle && onDeselect) onDeselect()
          return
        }
        // A handle drag never changes what is selected: the selection is what its
        // handles belong to.
        if (!handle && onSelect) onSelect(chosen.path)
        const startX = event.clientX
        const startY = event.clientY
        let moved = false
        const move = (moveEvent) => {
          const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * document_.canvas.width
          const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * document_.canvas.height
          if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return
          moved = true
          element.setAttribute('data-dragging', handle ? 'resize' : 'move')
          moveEvent.preventDefault()
        }
        const finish = (upEvent) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          draggingRef.current = false
          // A DRAG MOVES THE GROUND UNDER THE CURSOR. The box the pointer was over was
          // the box BEFORE the edit, so whatever this handler painted last no longer
          // describes anything - it is cleared, and the next real hover paints the
          // truth. A stale `ew-resize` on a layer that is no longer there is the same
          // lie as a cursor set mid-drag.
          element.style.cursor = ''
          triggerSelect.current = false
          if (element.hasPointerCapture && element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
          element.removeAttribute('data-dragging')
          if (!moved) return
          const dx = ((upEvent.clientX - startX) / Math.max(1, rect.width)) * document_.canvas.width
          const dy = ((upEvent.clientY - startY) / Math.max(1, rect.height)) * document_.canvas.height
          if (handle && onResize) onResize(chosen.path, handle, Math.round(dx), Math.round(dy))
          else if (onMove) onMove(chosen.path, Math.round(dx), Math.round(dy))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        draggingRef.current = true
        if (element.setPointerCapture) {
          try {
            element.setPointerCapture(event.pointerId)
          } catch (err) {
            // A capture the browser refuses is not a reason to lose the gesture: the
            // window listeners above already carry it.
          }
        }
      }

      /**
       * Hover feedback: the cursor names the gesture the pointer would start.
       *
       * A CURSOR SET WHILE THE BUTTON IS DOWN IS A LIE. A drag mutates the document and
       * the artboard re-renders, so the pointer that was over the old box is suddenly
       * over a different one - and whatever this handler last painted stays on screen
       * until the mouse moves again. `triggerSelect` is cleared by the first hover
       * after a press, and until then the cursor belongs to the drag, not to the hover.
       */
      const onArtPointerMove = (event) => {
        if (draggingRef.current) return
        // ONE hover is skipped after a selection changes: it is the move that carries
        // the pointer from wherever it was onto the new box, and the cursor it would
        // paint describes the selection BEFORE the click.
        if (triggerSelect.current) {
          triggerSelect.current = false
          return
        }
        const current = preparedRef.current
        const element = event.currentTarget
        if (!current || !selectedPath) {
          element.style.cursor = ''
          return
        }
        const { rect, tolerance } = toleranceFor(element)
        const point = pointIn(event, rect)
        const entry = current.boxes.find((candidate) => candidate.path === selectedPath)
        const edges = edgesFor(entry, point.x, point.y, tolerance)
        element.style.cursor = cursorFor(edges) ?? ''
      }

      // THE RULERS READ THE PAGE'S OWN GEOMETRY, measured from the stage: where the
      // artboard's top-left corner sits in the scroller (which is the design's origin)
      // and how many screen pixels one design pixel takes. Both change with the zoom
      // and with panning, so they are re-measured when either does.
      const [rigBox, setRigBox] = useState({ originX: 0, originY: 0, length: 0, breadth: 0 })
      useEffect(() => {
        const stage = wrapRef.current
        const rig = rigRef.current
        if (!stage || !rig) return undefined
        const measure = () => {
          const stageBox = stage.getBoundingClientRect()
          const artBox = rig.getBoundingClientRect()
          setRigBox({
            originX: artBox.left - stageBox.left + stage.scrollLeft,
            originY: artBox.top - stageBox.top + stage.scrollTop,
            length: stage.scrollWidth,
            breadth: stage.scrollHeight,
          })
        }
        measure()
        stage.addEventListener('scroll', measure, { passive: true })
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer) observer.observe(stage)
        return () => {
          stage.removeEventListener('scroll', measure)
          if (observer) observer.disconnect()
        }
      }, [scale, preparedVersion, zoom, document_.canvas.width, document_.canvas.height])

      // THE DESIGN'S OWN ORIGIN, reported on the artboard for the same reason the
      // version marker is: it is a fact about the layout that a person (or a check)
      // should be able to read without re-running the layout. `min` is the top-left
      // corner of everything the layout produced, in DESIGN pixels - a starter that
      // began at an arbitrary offset would make every number in the panel a fiction.
      const designOrigin = (() => {
        const preparedNow = preparedRef.current
        if (!preparedNow || !Array.isArray(preparedNow.boxes) || preparedNow.boxes.length === 0) return null
        let minX = Infinity
        let minY = Infinity
        for (const entry of preparedNow.boxes) {
          if (entry.box.x < minX) minX = entry.box.x
          if (entry.box.y < minY) minY = entry.box.y
        }
        return { x: Math.round(minX), y: Math.round(minY) }
      })()

      return h(
        'div',
        { className: 'dsc-pad', ref: wrapRef, 'data-canvas-stage': 'true' },
        h(Ruler, { axis: 'top', origin: rigBox.originX, scale, length: rigBox.length, thickness: 22 }),
        h(Ruler, { axis: 'left', origin: rigBox.originY, scale, length: rigBox.breadth, thickness: 22 }),
        h('div', { className: 'dsc-axisCorner', 'data-canvas-ruler-corner': 'true' }),
        h(
          'div',
          { className: 'dsc-rig', ref: rigRef, 'data-canvas-rig': 'true' },
          h(
            'div',
            {
              className: 'dsc-art',
              'data-canvas-artboard': document_.preset ?? 'freeform',
              'data-canvas-origin': '0,0',
              'data-canvas-layout-origin': designOrigin ? designOrigin.x + ',' + designOrigin.y : '',
              onPointerDown: onArtPointerDown,
              onPointerMove: onArtPointerMove,
              style: { width: Math.max(1, Math.round(document_.canvas.width * scale)) + 'px', height: Math.max(1, Math.round(document_.canvas.height * scale)) + 'px' },
            },
            h('canvas', { ref: canvasRef, 'data-canvas-art': 'true' }),
            // THE ORIGIN MARKER, on the artboard's own top-left corner: the design's
            // (0, 0), so a layer's x and y mean the same thing on screen and in the
            // document.
            h('div', { className: 'dsc-origin', 'data-canvas-origin-marker': 'true' },
              h('span', { className: 'dsc-originX' }),
              h('span', { className: 'dsc-originY' }),
              h('span', { className: 'dsc-originDot' }),
            ),
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
        ),
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

    /**
     * A RULER along one edge of the stage, LABELLED IN DESIGN PIXELS.
     *
     * The tick spacing is chosen so labels never collide (the same choice the audio
     * surface's time ruler makes), and every number is a position in the DESIGN's own
     * coordinate system - so the `x` a transform control shows is the same number the
     * ruler shows, and a design's (0, 0) is the artboard's top-left corner. The ruler
     * lives in the STAGE rather than on the artboard, so panning a zoomed design
     * scrolls the numbers past a fixed gutter instead of carrying them away.
     */
    function Ruler({ axis, origin, scale, length, thickness }) {
      const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((candidate) => candidate * Math.abs(scale) >= 64) ?? 10000
      const ticks = []
      const first = Math.ceil((-origin / scale) / step) * step
      const count = Math.floor((length - origin) / scale / step) + 1
      for (let index = 0; index < Math.max(0, count); index += 1) {
        const value = first + index * step
        const at = origin + value * scale
        if (at < thickness || at > length) continue
        ticks.push({ value, at })
      }
      const horizontal = axis === 'top'
      return h(
        axis === 'top' ? 'div' : 'div',
        {
          className: 'dsc-axis ' + (horizontal ? 'dsc-axisTop' : 'dsc-axisLeft'),
          'data-canvas-ruler': axis,
          style: horizontal ? { left: thickness, right: 0 } : { top: thickness, bottom: 0 },
        },
        ticks.map((tick) =>
          h('span', {
            key: 'tick-' + tick.value,
            className: 'dsc-axisTick',
            style: horizontal ? { left: Math.round(tick.at - thickness) + 'px' } : { top: Math.round(tick.at - thickness) + 'px' },
          }),
        ),
        ticks.map((tick) =>
          h('span', {
            key: 'label-' + tick.value,
            className: 'dsc-axisLabel',
            style: horizontal ? { left: Math.round(tick.at - thickness) + 'px' } : { top: Math.round(tick.at - thickness) + 'px' },
          }, String(tick.value)),
        ),
      )
    }

    /**
     * The handles ONE node kind can honour, which is not the same list for all of
     * them.
     *
     * A TEXT node's height is what its words measure: it is stretched in WIDTH, and
     * the only handles that can do that are the two SIDE MIDPOINTS. It used to carry
     * the four corners too, and that was the dead gesture this alpha fixes - a corner
     * is a vertical resize as much as a horizontal one, so a drag that began on the
     * top-left square of a text layer wrote a width, dropped the height it could not
     * honour, and left a selection that looked like it refused to move. With only the
     * side handles drawn and hit-tested, the cursor and the gesture agree: the sides
     * stretch, everything else moves.
     */
    function handlesFor(rect) {
      if (!rect || rect.kind === 'text') return ['w', 'e']
      return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    }

    /** The centre of every handle of a box, in design pixels, in draw order. */
    function handlePoints(box, keys) {
      const midX = box.x + box.w / 2
      const midY = box.y + box.h / 2
      const at = {
        nw: [box.x, box.y],
        n: [midX, box.y],
        ne: [box.x + box.w, box.y],
        e: [box.x + box.w, midY],
        se: [box.x + box.w, box.y + box.h],
        s: [midX, box.y + box.h],
        sw: [box.x, box.y + box.h],
        w: [box.x, midY],
      }
      return keys.map((key) => ({ key, x: at[key][0], y: at[key][1] }))
    }

    /** The cursor an edge pair deserves. */
    function cursorFor(edges) {
      if (!edges) return null
      if ((edges.left || edges.right) && (edges.top || edges.bottom)) return (edges.left ? 'nesw' : 'nwse') + '-resize'
      if (edges.left || edges.right) return 'ew-resize'
      return 'ns-resize'
    }

    /**
     * Which edge of a box is under a point, in DESIGN pixels.
     *
     * A handle is grabbed within `tolerance` design pixels of an edge of the box the
     * overlay draws its squares on, so the person grabs what they can see at any
     * zoom. The tolerance arrives already converted from SCREEN pixels against the
     * rect the overlay was drawn with.
     *
     * `allowed` is the handle set that box actually carries (see `handlesFor`), and it
     * is not decoration: an edge that is NOT drawn must not be hit-tested either, or
     * the gesture contradicts the picture - a text layer, whose height is what its
     * words measure, was grabbed as a VERTICAL RESIZE a design pixel inside its own
     * top border, so the drag stretched nothing (the height op was dropped) and the
     * selection looked like it refused to move. Pure data in, pure data out.
     */
    function edgesAt(box, pointX, pointY, tolerance, allowed) {
      if (!box) return null
      const keys = Array.isArray(allowed) && allowed.length > 0 ? allowed : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      // A corner handle belongs to two edges, so the edges this box carries are
      // UNIONED from the handles: the top edge exists when a top-row square does.
      // Testing the corner KEYS themselves would be wrong - 'nw' is not the north
      // edge, and a text node carries the corner without carrying the edge.
      const boxKeys = new Set(keys)
      const canLeft = boxKeys.has('w') || boxKeys.has('nw') || boxKeys.has('sw')
      const canRight = boxKeys.has('e') || boxKeys.has('ne') || boxKeys.has('se')
      const canTop = boxKeys.has('n') || boxKeys.has('nw') || boxKeys.has('ne')
      const canBottom = boxKeys.has('s') || boxKeys.has('sw') || boxKeys.has('se')
      const tolX = tolerance.x
      const tolY = tolerance.y
      const near = {
        left: canLeft && Math.abs(pointX - box.x) <= tolX,
        right: canRight && Math.abs(pointX - (box.x + box.w)) <= tolX,
        top: canTop && Math.abs(pointY - box.y) <= tolY,
        bottom: canBottom && Math.abs(pointY - (box.y + box.h)) <= tolY,
      }
      const insideX = pointX >= box.x - tolX && pointX <= box.x + box.w + tolX
      const insideY = pointY >= box.y - tolY && pointY <= box.y + box.h + tolY
      if (!insideX || !insideY) return null
      const edges = { left: near.left, right: near.right, top: near.top, bottom: near.bottom }
      if (!edges.left && !edges.right && !edges.top && !edges.bottom) return null
      return edges
    }

    /**
     * The pointer operations a resize gesture writes, as data.
     *
     * The same route, validator and store as a move and as the agent's patch, so
     * stretching a layer cannot produce a document the validator would refuse. Two
     * rules are worth stating:
     *
     *   - A node that was `hug` gets a NUMBER, taken from the box it already had.
     *     Dragging is how you take a label off its content and give it a width.
     *   - A TEXT node is stretched in WIDTH only: its height is what the words
     *     measure, and setting it would be a lie the layout then ignores.
     */
    function resizeOps(path, node, entry, edges, dx, dy) {
      if (!node || typeof node !== 'object' || !edges) return []
      const baseX = typeof node.x === 'number' ? node.x : entry ? Math.round(entry.box.x) : 0
      const baseY = typeof node.y === 'number' ? node.y : entry ? Math.round(entry.box.y) : 0
      const baseW = typeof node.w === 'number' ? node.w : entry ? Math.round(entry.box.w) : 0
      const baseH = typeof node.h === 'number' ? node.h : entry ? Math.round(entry.box.h) : 0
      const minW = node.kind === 'text' ? 40 : 8
      const minH = 8
      const ops = []
      if (edges.left || edges.right) {
        const want = Math.max(minW, Math.round(edges.left ? baseW - dx : baseW + dx))
        ops.push({ op: 'set', at: path + '.w', value: want })
        if (edges.left) ops.push({ op: 'set', at: path + '.x', value: Math.max(0, Math.round(baseX + (baseW - want))) })
      }
      if (node.kind !== 'text' && (edges.top || edges.bottom)) {
        const want = Math.max(minH, Math.round(edges.top ? baseH - dy : baseH + dy))
        ops.push({ op: 'set', at: path + '.h', value: want })
        if (edges.top) ops.push({ op: 'set', at: path + '.y', value: Math.max(0, Math.round(baseY + (baseH - want))) })
      }
      return ops
    }

    /**
     * The operations a NUDGE writes: the four directions a person reaches for without
     * aiming, at a step they choose (1px for placing, 10 for moving).
     *
     * A node positioned by x/y keeps its own values. One that is in a frame's flow has
     * none, so the box the layout produced is the position it already has - which is
     * exactly what takes it out of the flow, the documented rule the drag uses too.
     */
    function nudgeOps(path, node, entry, dx, dy) {
      if (!node || typeof node !== 'object' || (!dx && !dy)) return []
      const baseX = typeof node.x === 'number' ? node.x : entry ? Math.round(entry.box.x) : 0
      const baseY = typeof node.y === 'number' ? node.y : entry ? Math.round(entry.box.y) : 0
      const ops = []
      if (dx) ops.push({ op: 'set', at: path + '.x', value: Math.max(0, Math.round(baseX + dx)) })
      if (dy) ops.push({ op: 'set', at: path + '.y', value: Math.max(0, Math.round(baseY + dy)) })
      return ops
    }

    /**
     * The operation a SIZE field writes: a width or a height in design pixels.
     *
     * The same two rules the handles follow, in one place: a text node has no height it
     * can be given (its words measure it), so that field is refused rather than written
     * and ignored - and a `hug` node, which has no number at all, takes the box the
     * layout produced the moment a person types over it.
     */
    function sizeOps(path, node, entry, axis, value) {
      if (!node || typeof node !== 'object' || (axis !== 'w' && axis !== 'h')) return []
      if (axis === 'h' && node.kind === 'text') return []
      const min = axis === 'w' ? (node.kind === 'text' ? 40 : 8) : 8
      const current = typeof node[axis] === 'number' ? node[axis] : entry ? Math.round(entry.box[axis]) : min
      const want = Math.max(min, Math.round(Number.isFinite(value) ? value : current))
      if (want === current && typeof node[axis] === 'number') return []
      return [{ op: 'set', at: path + '.' + axis, value: want }]
    }

    /** The op a ROTATION writes: degrees, which the language bounds to -360..360. */
    function rotateOps(path, node, degrees) {
      if (!node || typeof node !== 'object' || !Number.isFinite(degrees)) return []
      const want = Math.max(-360, Math.min(360, Math.round(degrees)))
      if (want === (typeof node.rotate === 'number' ? Math.round(node.rotate) : 0)) return []
      return [{ op: 'set', at: path + '.rotate', value: want }]
    }

    /** The op an OPACITY writes: 0..1, rounded to two places so a slider is not noise. */
    /**
     * The op an OPACITY writes: 0..1, rounded to two places so a slider is not noise.
     *
     * THE COMPARISON IS AGAINST WHAT IS WRITTEN, NOT AGAINST A DEFAULT. "1 is the
     * default, so leave it out" is only sound when the document actually carries that
     * representation: a node whose opacity is 0.5 and whose slider is dragged back to
     * 100% must WRITE 1, or the reset is silently dropped and the layer stays faint.
     * The rule is uniform instead - a value equal to the field already written is not
     * rewritten, and anything else is.
     */
    function opacityOps(path, node, value) {
      if (!node || typeof node !== 'object' || !Number.isFinite(value)) return []
      const want = Math.max(0, Math.min(1, Math.round(value * 100) / 100))
      const current = typeof node.opacity === 'number' ? node.opacity : null
      if (current === want) return []
      return [{ op: 'set', at: path + '.opacity', value: want }]
    }

    /**
     * What a node's COLOUR control may edit, as a list of paint targets.
     *
     * The language gives each kind its own colour field - a text node paints its glyphs
     * with `color`, a shape with `fill` and `stroke`, a frame with `background`, and an
     * `art` node with a `colors` array - and a kind that paints nothing (an image, an
     * SVG document) has NO targets, which is why this answers a list rather than a
     * field name: the control draws one row per entry, and an empty list is what makes
     * it say there is nothing to recolour instead of writing a property nothing reads.
     */
    function paintTargets(node) {
      if (!node || typeof node !== 'object') return []
      const targets = []
      if (node.kind === 'text') targets.push({ key: 'color', label: 'Text', paint: node.color })
      if (node.kind === 'shape') {
        targets.push({ key: 'fill', label: 'Fill', paint: node.fill })
        if (node.stroke !== undefined) targets.push({ key: 'stroke', label: 'Stroke', paint: node.stroke })
      }
      if (node.kind === 'frame') targets.push({ key: 'background', label: 'Background', paint: node.background })
      if (node.kind === 'svg' && node.fill !== undefined) targets.push({ key: 'fill', label: 'Fill', paint: node.fill })
      if (node.kind === 'art') {
        const colors = Array.isArray(node.colors) && node.colors.length > 0 ? node.colors : [null, null, null]
        colors.slice(0, 4).forEach((color, index) => targets.push({ key: 'colors.' + index, label: 'Colour ' + (index + 1), paint: color }))
      }
      return targets
    }

    /**
     * The current colour of one paint target, as a `#rrggbb` for an `<input type=color>`
     * or null when the paint is not a flat colour (a gradient, an art fill, a missing
     * value). A control that showed `#000000` for a gradient would be lying.
     */
    function paintColorOf(paint) {
      if (typeof paint === 'string') return /^#[0-9a-fA-F]{6}$/.test(paint) ? paint.toLowerCase() : /^#[0-9a-fA-F]{3}$/.test(paint) ? '#' + paint[1] + paint[1] + paint[2] + paint[2] + paint[3] + paint[3] : null
      if (paint && typeof paint === 'object' && paint.type === 'solid' && typeof paint.color === 'string') return paintColorOf(paint.color)
      return null
    }

    /** The op that recolours one target. A solid paint is written as its own colour. */
    function colorOps(path, target, color) {
      if (!target || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return []
      const canonical = color.toLowerCase()
      const current = paintColorOf(target.paint)
      if (current === canonical) return []
      // A gradient or an art fill is replaced by a flat colour on purpose: the control
      // offers one colour, and writing `{type:'solid'}` is the document's own canonical
      // form for it - a person who wants the gradient back asks the model for it.
      return [{ op: 'set', at: path + '.' + target.key, value: canonical }]
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
          // EIGHT handles for a box, SIX for text: four corners and four edge
          // midpoints, which is the vocabulary a person already knows from every
          // other design tool, and the ones the resize gesture grabs. A text node has
          // no vertical handles because it has no height it can be given.
          const size = Math.max(5, Math.round(7 / Math.max(0.2, scale)))
          for (const point of handlePoints(entry.box, handlesFor(entry))) {
            children.push(h('rect', { key: 'handle-' + point.key, 'data-canvas-handle': point.key, x: point.x - size / 2, y: point.y - size / 2, width: size, height: size, fill: 'rgba(77,107,254,0.95)' }))
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
      /** Which job the right bar is doing: shaping the design, or auditing it. */
      const [sideTab, setSideTab] = useState('design')
      /**
       * Which SURFACE the pane is showing: the pack's own design surface, or the
       * vendored Excalidraw editor. The second is a preview - the document is not
       * the scene yet and the agent tools still speak this package's language - so
       * it is a mode in the same tab and not a second tab type, and the note under
       * it says exactly that.
       */
      const [surface, setSurface] = useState('design')
      /**
       * The design the rail is asking about right now, as a two-step DELETE: the
       * first click arms the row, the second removes it. A design is somebody's
       * work, and one stray click in a list should never destroy it - and because
       * the arming lives on the row itself, the question is asked where the answer
       * is, not in a dialog over the whole surface.
       */
      const [confirmDelete, setConfirmDelete] = useState(null)
      /**
       * The export menu (a native `<details>`, so it closes on a click anywhere else
       * and on Escape without this file owning either behaviour) and WHICH export is
       * running, kept as a sentence rather than a flag so the row can say what it is
       * doing instead of just going dead.
       */
      const exportMenuRef = useRef(null)
      const [exporting, setExporting] = useState('')
      /** The step a nudge moves: 1px for placing, 10px for moving. */
      const [nudgeStep, setNudgeStep] = useState(1)
      /** The node the layer list and the drag both address, as a document path. */
      const [selectedPath, setSelectedPath] = useState(null)
      /**
       * Whether the surface already knows what is selected at the moment a pointer
       * lands.
       *
       * A hover cursor is painted by MUTATING the element's style, and the browser
       * keeps it until something sets it again - so a cursor left over from a
       * selection that has just been replaced promised a gesture the new selection
       * cannot perform. The flag is written at POINTER DOWN (in the same event, before
       * any state update React may batch) and consumed by the hover handler, which
       * knows whether the pointer that painted the cursor was down or not.
       */
      const triggerSelect = useRef(false)
      // A DESELECT CLEARS THE CURSOR TOO: the cursor that promised a resize belonged
      // to a selection that no longer exists.
      const deselectPath = useCallback(() => {
        if (wrapRef.current) wrapRef.current.style.cursor = ''
        setSelectedPath(null)
      }, [])
      const selectPath = useCallback((path) => {
        triggerSelect.current = true
        setSelectedPath(path)
      }, [])
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

      // The selection belongs to ONE design: switching designs clears it, and it also
      // DISARMS any delete question the rail was asking - an armed row that survived a
      // switch would be a control offering to delete something the person is no
      // longer looking at.
      useEffect(() => {
        setSelectedPath(null)
        setConfirmDelete(null)
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

      /**
       * A drag on a selection handle: RESIZE one node, keeping the opposite edge
       * where it is.
       *
       * The gesture and the operations it writes are both decided ELSEWHERE and both
       * are pure data: `edgesAt` says which edges the pointer grabbed, `resizeOps`
       * says which pointer ops those edges produce. This function only names them and
       * sends them through the same route the agent's `canvas_patch` uses.
       */
      const resizeLayer = useCallback(
        (path, edges, dx, dy) => {
          if (!selected || !edges) return
          const node = nodeAtPath(selected.document, path)
          if (!node || typeof node !== 'object') return
          const prepared = lastPreparedRef.current
          const entry = prepared ? prepared.boxes.find((box) => box.path === path) : null
          const ops = resizeOps(path, node, entry, edges, dx, dy)
          if (ops.length === 0) return
          const corner = (edges.left || edges.right) && (edges.top || edges.bottom)
          applyOps(ops, (corner ? 'Resized ' : 'Stretched ') + layerLabel(node, path))
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

      /**
       * Delete one design, after the person has confirmed it on the row.
       *
       * The same route `canvas_delete` posts to, addressed by id AND scope, so a
       * library design is removed from the library and a conversation one from the
       * conversation - never the wrong one. The design is dropped from the local
       * payload immediately afterwards, because the rail and the artboard read that
       * payload and a deleted design must stop being drawn at once; the host's answer
       * is what says whether the removal actually happened.
       */
      const deleteDesign = useCallback(
        async (entry) => {
          if (!entry || !sessionId) return
          setBusy(true)
          setNote(null)
          try {
            const answer = await api(DELETE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, id: entry.id, scope: entry.scope }),
            })
            if (answer && answer.removed) {
              removeDesign(storeFor(sessionId), entry.id)
              setSelectedId((current) => (current === entry.id ? null : current))
              setSelectedPath(null)
              setNote({ kind: 'info', text: 'Deleted ' + entry.title + '.' })
            } else {
              setNote({ kind: 'error', text: 'The host did not find ' + entry.id + ' to delete.' })
            }
          } catch (err) {
            setNote({ kind: 'error', text: err && err.message ? err.message : 'the design could not be deleted' })
          } finally {
            setBusy(false)
            setConfirmDelete(null)
          }
        },
        [sessionId],
      )

      /**
       * SAVE: the design is already persisted by the host on every edit, so what this
       * does is CONFIRM it - it re-reads the state and reports the revision the host
       * holds, which is the one fact a person wants before they close the tab. It
       * deliberately does not invent a second persistence path: two writers for one
       * document is how a document forks.
       */
      const saveDesign = useCallback(async () => {
        if (!selected || !sessionId) return
        setBusy(true)
        setNote(null)
        try {
          const payload = await api(STATE_ROUTE + '?session=' + encodeURIComponent(sessionId))
          applyState(storeFor(sessionId), payload)
          const designs = Array.isArray(payload && payload.designs) ? payload.designs : []
          const saved = designs.find((entry) => entry.id === selected.id) ?? null
          setNote({
            kind: 'info',
            text: saved
              ? 'Saved: ' + saved.id + ' is on the host at revision ' + saved.revision + (saved.title ? ' (' + saved.title + ')' : '') + '.'
              : selected.id + ' is no longer in this conversation.',
          })
        } catch (err) {
          setNote({ kind: 'error', text: err && err.message ? err.message : 'the design could not be confirmed' })
        } finally {
          setBusy(false)
        }
      }, [selected, sessionId])

      /** Start a new design from a preset + archetype. */
      const createDesign = useCallback(
        async (presetId, archetypeId, styleId, exampleId) => {
          if (!sessionId) return
          setBusy(true)
          setNote(null)
          setNewOpen(false)
          try {
            const body = exampleId
              ? { session: sessionId, document: null, example: exampleId, style: styleId ?? null }
              : { session: sessionId, document: null, preset: presetId, archetype: archetypeId, style: styleId ?? null }
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
        async (format, scale, target, label) => {
          if (!engine || !selected || !sessionId) return
          setBusy(true)
          setExporting(label ?? format)
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
            // The menu closes on a WRITE, not on the gesture that started it: a failed
            // export leaves it open, on the row the person is about to press again.
            const menu = exportMenuRef.current
            if (menu) menu.open = false
            refresh(sessionId, { force: true }).catch(() => {})
          } catch (err) {
            setNote({ kind: 'error', text: err && err.message ? err.message : 'the export failed' })
          } finally {
            setBusy(false)
            setExporting('')
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

      /**
       * One decision from the transform controls: nudge, size, scale, rotate, opacity
       * or colour. Everything it writes goes through `applyTransformOps`, which is the
       * same validator the agent's patch and the drag use - so a control can offer a
       * value the language refuses (too small, out of range) and be told so, rather
       * than writing a document nothing validates.
       */
      const applyTransformOps = useCallback(
        (ops, label) => {
          if (!selectedPath || ops.length === 0) return
          applyOps(ops, label)
        },
        [selectedPath, applyOps],
      )

      /** The selected node and the box it was laid out into, as the controls read them. */
      const transformSubject = useCallback(() => {
        if (!selected || !selectedPath) return null
        const node = nodeAtPath(selected.document, selectedPath)
        if (!node || typeof node !== 'object') return null
        const prepared = lastPreparedRef.current
        const entry = prepared ? prepared.boxes.find((row) => row.path === selectedPath) : null
        return { node, entry: entry ? { box: entry.box, kind: entry.kind } : null, path: selectedPath }
      }, [selected, selectedPath])

      /** Eight-way placement, in design pixels, at the step the person chose. */
      const nudgeLayer = useCallback(
        (dx, dy) => {
          const subject = transformSubject()
          if (!subject) return
          applyTransformOps(nudgeOps(subject.path, subject.node, subject.entry, dx, dy), 'Moved ' + layerLabel(subject.node, subject.path))
        },
        [transformSubject, applyTransformOps],
      )

      /** A typed width or height. */
      const sizeLayer = useCallback(
        (axis, raw) => {
          const subject = transformSubject()
          if (!subject) return
          applyTransformOps(sizeOps(subject.path, subject.node, subject.entry, axis, Number(raw)), 'Sized ' + layerLabel(subject.node, subject.path))
        },
        [transformSubject, applyTransformOps],
      )

      /**
       * A scale factor on the size the layer HAS - the box the layout produced when the
       * node carries no number of its own, which is the difference between "make this
       * 10% bigger" and "give it a number I invented".
       */
      const scaleLayer = useCallback(
        (factor) => {
          const subject = transformSubject()
          if (!subject || !Number.isFinite(factor)) return
          const box = subject.entry ? subject.entry.box : null
          const w = typeof subject.node.w === 'number' ? subject.node.w : box ? box.w : null
          const h = typeof subject.node.h === 'number' ? subject.node.h : box ? box.h : null
          if (w === null) return
          const ops = []
          if (w !== null) ops.push(...sizeOps(subject.path, subject.node, subject.entry, 'w', w * factor))
          if (h !== null) ops.push(...sizeOps(subject.path, subject.node, subject.entry, 'h', h * factor))
          applyTransformOps(ops, 'Scaled ' + layerLabel(subject.node, subject.path) + ' \u00d7' + factor)
        },
        [transformSubject, applyTransformOps],
      )

      /** Rotation, in degrees, and the reset back to zero. */
      const rotateLayer = useCallback(
        (degrees) => {
          const subject = transformSubject()
          if (!subject) return
          applyTransformOps(rotateOps(subject.path, subject.node, degrees), degrees === 0 ? 'Straightened ' + layerLabel(subject.node, subject.path) : 'Rotated ' + layerLabel(subject.node, subject.path) + ' to ' + Math.round(degrees) + '\u00b0')
        },
        [transformSubject, applyTransformOps],
      )

      /** The layer's own opacity. */
      const opacityLayer = useCallback(
        (value) => {
          const subject = transformSubject()
          if (!subject) return
          applyTransformOps(opacityOps(subject.path, subject.node, value), 'Set the opacity of ' + layerLabel(subject.node, subject.path))
        },
        [transformSubject, applyTransformOps],
      )

      /** One paint target's colour, by the key `paintTargets` gave it. */
      const colorLayer = useCallback(
        (key, color) => {
          const subject = transformSubject()
          if (!subject) return
          const target = paintTargets(subject.node).find((row) => row.key === key)
          const ops = colorOps(subject.path, target, color)
          if (ops.length === 0) return
          applyTransformOps(ops, 'Recoloured ' + layerLabel(subject.node, subject.path))
        },
        [transformSubject, applyTransformOps],
      )

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
        selected ? h(Pill, { verification: selected.verification }) : null,
        h('span', { className: 'dsc-spacer' }),
        // ZOOM IS A MENU TOO: five rungs in the bar was a row of buttons for what is
        // one choice, and the rungs are still all there - the summary simply says
        // which one is in force.
        h('details', { className: 'dsc-menu', 'data-canvas-zoom': 'true' },
          h('summary', { className: 'dsc-btn', title: 'How much of the design the pane shows' }, 'Zoom: ' + (zoom === 'fit' ? 'Fit' : Math.round(zoom * 100) + '%') + ' \u25be'),
          h('div', { className: 'dsc-menuPanel' },
            ZOOM_STEPS.map((step) => h('button', {
              key: 'zoom-' + step,
              type: 'button',
              className: 'dsc-menuItem',
              'data-canvas-zoom-step': String(step),
              'data-active': zoom === step ? 'true' : 'false',
              onClick: (event) => { event.preventDefault(); setZoom(step); event.currentTarget.closest('details').open = false },
            },
              h('span', { className: 'dsc-menuLabel' }, step === 'fit' ? 'Fit' : Math.round(step * 100) + '%'),
              h('span', { className: 'dsc-menuHint' }, step === 'fit' ? 'The whole design in the pane' : step === 1 ? 'Actual pixels' : step < 1 ? 'Smaller' : 'Twice the pixels'),
            )),
          ),
        ),
        h('div', { className: 'dsc-barGroup' },
          h(Btn, { active: overlays.safe, onClick: () => setOverlays((value) => ({ ...value, safe: !value.safe })), title: 'Show the preset\u2019s safe and keep-out areas' }, 'Safe areas'),
          h(Btn, { active: overlays.boxes, onClick: () => setOverlays((value) => ({ ...value, boxes: !value.boxes })), title: 'Show every node\u2019s box' }, 'Boxes'),
        ),
        // THE SURFACE SWITCH, and the whole point of this increment: the vendored
        // Excalidraw editor, loaded from this package's own route on first use.
        // Its label says PREVIEW because that is what it is until the document,
        // the tools and the assets are re-pointed at the scene.
        h('button', {
          type: 'button',
          className: 'dsc-btn',
          'data-canvas-action': 'surface',
          'data-active': surface === 'excalidraw' ? 'true' : 'false',
          title: 'Show the vendored Excalidraw editor in place of the design surface',
          onClick: () => setSurface((value) => (value === 'excalidraw' ? 'design' : 'excalidraw')),
        }, surface === 'excalidraw' ? 'Design \u25be' : 'Excalidraw preview \u25be'),
        // ONE EXPORT CONTROL, not four buttons. Format and destination are two axes
        // of ONE decision, and four buttons for it was the first thing to wrap out of
        // the bar when the pane got narrow - so what is left in the bar is the
        // decision, and the menu holds the axes.
        h('details', { className: 'dsc-menu', 'data-canvas-export': 'true', ref: exportMenuRef },
          h('summary', {
            className: 'dsc-btn',
            'data-kind': 'primary',
            'data-active': exporting ? 'true' : 'false',
            'aria-disabled': busy || !selected ? 'true' : 'false',
            title: selected ? 'Write this design to a file' : 'Nothing to export yet',
          }, exporting ? 'Exporting\u2026' : 'Export \u25be'),
          h('div', { className: 'dsc-menuPanel' },
            h('button', {
              type: 'button',
              className: 'dsc-menuItem',
              'data-canvas-export-item': 'png-1',
              disabled: busy || !selected,
              onClick: (event) => { event.preventDefault(); exportDesign('png', 1, 'desktop', 'PNG') },
            },
              h('span', { className: 'dsc-menuLabel' }, 'PNG'),
              h('span', { className: 'dsc-menuHint' }, 'The canvas at its own pixels \u2192 Desktop'),
            ),
            h('button', {
              type: 'button',
              className: 'dsc-menuItem',
              'data-canvas-export-item': 'png-2',
              disabled: busy || !selected,
              onClick: (event) => { event.preventDefault(); exportDesign('png', 2, 'desktop', 'PNG 2\u00d7') },
            },
              h('span', { className: 'dsc-menuLabel' }, 'PNG \u00d7 2'),
              h('span', { className: 'dsc-menuHint' }, 'Twice the pixels, same composition'),
            ),
            h('button', {
              type: 'button',
              className: 'dsc-menuItem',
              'data-canvas-export-item': 'svg',
              disabled: busy || !selected,
              onClick: (event) => { event.preventDefault(); exportDesign('svg', 1, 'desktop', 'SVG') },
            },
              h('span', { className: 'dsc-menuLabel' }, 'SVG'),
              h('span', { className: 'dsc-menuHint' }, 'Vector, with the bundled fonts embedded'),
            ),
            h('button', {
              type: 'button',
              className: 'dsc-menuItem',
              'data-canvas-export-item': 'png-workspace',
              disabled: busy || !selected,
              onClick: (event) => { event.preventDefault(); exportDesign('png', 1, 'workspace', 'PNG \u2192 workspace') },
            },
              h('span', { className: 'dsc-menuLabel' }, 'PNG \u2192 workspace'),
              h('span', { className: 'dsc-menuHint' }, 'Write into the conversation folder'),
            ),
          ),
        ),
        h(Btn, { active: drawer, onClick: () => setDrawer((value) => !value), title: 'Edit the document' }, 'Source'),
        // SAVE: what it promises is that the design is on the host's disk at the
        // revision on screen - which is the fact a person wants before closing the
        // tab, and a fact only the HOST can answer. So it re-reads the design rather
        // than pretending to write one: no optimistically-saved document can disagree
        // with the file.
        h(Btn, { onClick: saveDesign, disabled: busy || !selected, title: 'Confirm this revision is saved on the host' }, 'Save'),
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
              'data-armed': confirmDelete === entry.id ? 'true' : 'false',
              'data-canvas-design': entry.id,
              onClick: () => setSelectedId(entry.id),
              title: entry.title,
            },
            h('div', { className: 'dsc-rowTitle' },
              h('span', { className: 'dsc-rowName' }, entry.title),
              h(Pill, { verification: entry.verification }),
              // THE DELETE CONTROL: one small × on the row, revealed on hover or on
              // the selected row, which becomes the question on the first click and
              // the commit on the second.
              confirmDelete === entry.id
                ? h('span', { className: 'dsc-rowConfirm' },
                    h('button', {
                      type: 'button',
                      className: 'dsc-mini dsc-danger',
                      'data-canvas-delete-confirm': entry.id,
                      disabled: busy,
                      title: 'Delete this design from ' + (entry.scope === 'library' ? 'the library' : 'this conversation'),
                      onClick: (event) => { event.stopPropagation(); deleteDesign(entry) },
                    }, 'Delete'),
                    h('button', { type: 'button', className: 'dsc-mini', title: 'Keep it', onClick: (event) => { event.stopPropagation(); setConfirmDelete(null) } }, 'Keep'),
                  )
                : h('button', {
                    type: 'button',
                    className: 'dsc-mini dsc-rowDelete',
                    'data-canvas-delete': entry.id,
                    disabled: busy,
                    title: 'Delete this design',
                    onClick: (event) => { event.stopPropagation(); setConfirmDelete(entry.id) },
                  }, '\u00d7'),
            ),
            h('div', { className: 'dsc-rowMeta' }, (entry.preset ?? 'free-form') + ' \u00b7 rev ' + entry.revision + ' \u00b7 ' + entry.warnings + ' warn'),
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
              onSelect: selectPath,
              onDeselect: deselectPath,
              onMove: moveLayer,
              onResize: resizeLayer,
              triggerSelect,
            })
          : h('div', { className: 'dsc-padEmpty' }, h(EmptyState, { engineNote, error, state, onCreate: createDesign, onOpenNew: () => setNewOpen(true) })),
      )

      const layers = selected ? layerTree(selected.document) : []
      const styleLibrary = (state && state.styles) || []
      const currentStyleId = selected && selected.document ? selected.document.style ?? null : null
      const currentStyle = styleLibrary.find((entry) => entry.id === currentStyleId) ?? null
      // THE TWO PANES. `design` is what a person edits with; `inspect` is what they
      // judge with. They are never shown together, which is the whole point: neither
      // can push the other out of the bar.
      const designPane = h(
        'div',
        { className: 'dsc-pane', 'data-canvas-pane': 'design' },
        // THE STYLE this design carries: its name, what it is for, and the rules the
        // person and the model are both held to. Coming from the same pack the
        // transform reads, so the advice cannot drift from the look. ONE do, one
        // don't and one gate - the style library holds the rest, and a card that
        // lists six rules is a wall of text in a 296px bar.
        currentStyle
          ? h('div', { className: 'dsc-styleCard', 'data-canvas-style-card': currentStyle.id },
              h('strong', null, currentStyle.name),
              h('span', { className: 'dsc-styleIntent', title: currentStyle.intent }, currentStyle.intent),
              ...(currentStyle.do || []).slice(0, 1).map((rule, index) => h('span', { key: 'do-' + index, className: 'dsc-styleRule' }, h('b', null, 'Do: '), rule)),
              ...(currentStyle.dont || []).slice(0, 1).map((rule, index) => h('span', { key: 'dont-' + index, className: 'dsc-styleRule' }, h('b', null, 'Don\u2019t: '), rule)),
              ...(currentStyle.gates || []).slice(0, 1).map((gate, index) => h('span', { key: 'gate-' + index, className: 'dsc-styleRule' }, h('b', null, 'Gate: '), gate)),
            )
          : styleLibrary.length > 0
            ? h('p', { className: 'dsc-rowMeta' }, 'No style yet - pick one above, or ask the agent for a look.')
            : null,
        // THE LAYER LIST: every node of the design, in paint order, nested. A row
        // selects the node the drag will move; the arrows reorder it inside its own
        // array; the values are the design's own, in design pixels. The list owns its
        // own scrollport, so two hundred layers cost the lints under it nothing.
        h('div', { className: 'dsc-section', 'data-grow': 'true' },
          h('div', { className: 'dsc-sectionHead' }, h('span', null, 'Layers'), h('span', null, selected ? layers.length + ' node(s)' : '')),
          h('div', { className: 'dsc-layersScroll' },
            layers.length > 0
              ? h('ul', { className: 'dsc-layers', 'data-canvas-layers': 'true' },
                  layers.map((row) =>
                    h('li', {
                      key: row.path,
                      className: 'dsc-layer',
                      'data-selected': row.path === selectedPath ? 'true' : 'false',
                      'data-layer-path': row.path,
                      // The indent is CAPPED: a deeply nested node stops walking off
                      // the right edge of a 296px bar, and the row's tooltip still
                      // carries its kind and its full path.
                      style: { paddingLeft: 6 + Math.min(row.depth, 6) * 8 + 'px' },
                      onClick: () => setSelectedPath(row.path),
                      title: row.node.kind + ' \u00b7 ' + row.path,
                    },
                      h('span', { className: 'dsc-layerKind' }, layerKindBadge(row.node.kind)),
                      h('span', { className: 'dsc-layerName' }, layerLabel(row.node, row.path)),
                      h('span', { className: 'dsc-layerTools' },
                        h('button', { type: 'button', className: 'dsc-mini', title: 'Move up in this array', disabled: busy || row.path.endsWith('.0'), onClick: (event) => { event.stopPropagation(); reorderLayer(row.path, 'up') } }, '\u2191'),
                        h('button', { type: 'button', className: 'dsc-mini', title: 'Move down in this array', disabled: busy, onClick: (event) => { event.stopPropagation(); reorderLayer(row.path, 'down') } }, '\u2193'),
                      ),
                    ),
                  ),
                )
              : h('p', { className: 'dsc-rowMeta' }, selected ? 'This design has no layers yet.' : 'No design selected.'),
          ),
        ),
        // THE LINTS: the same advisory list the model is handed, for the revision on
        // screen. They live in the SHAPING pane rather than the auditing one because
        // they are a to-do list - what a person acts on while editing.
        h('div', { className: 'dsc-section' },
          h('div', { className: 'dsc-sectionHead' }, h('span', null, 'Lints'), h('span', null, lints ? lints.length + ' \u00b7 rev ' + (selected ? selected.revision : '?') : 'laying out\u2026')),
          lints && lints.length > 0
            ? h('ul', { className: 'dsc-lints' }, lints.map((lint, index) => h(LintLine, { key: lint.code + index, lint })))
            : h('p', { className: 'dsc-rowMeta' }, lints ? 'None.' : 'Laying out\u2026'),
        ),
      )

      // THE INSPECT PANE: the SELECTED LAYER, as controls rather than prose. A person
      // shapes a design by dragging on the artboard and by typing here, and the two
      // write through the SAME document route the agent's `canvas_patch` uses - so a
      // button press and a drag cannot produce different documents. The black feed
      // thumbnail that used to sit here is GONE: it duplicated the artboard at a
      // quarter scale and showed nothing the canvas was not already showing.
      const selectedNode = selected && selectedPath ? nodeAtPath(selected.document, selectedPath) : null
      const selectedBox = (() => {
        const prepared = lastPreparedRef.current
        if (!prepared || !selectedPath) return null
        const entry = prepared.boxes.find((row) => row.path === selectedPath)
        return entry ? entry.box : null
      })()
      const targets = paintTargets(selectedNode)
      const designColors = (() => {
        const tokens = selected && selected.document && selected.document.tokens ? selected.document.tokens.color : null
        return tokens && typeof tokens === 'object' ? Object.values(tokens).filter((value) => typeof value === 'string') : []
      })()
      const transformPane = !selectedNode
        ? h('p', { className: 'dsc-rowMeta' }, 'Select a layer to transform it - click one in the layer list, or on the canvas.')
        : h(
            React.Fragment,
            null,
            h('div', { className: 'dsc-section', 'data-canvas-transform': 'true' },
              h('div', { className: 'dsc-sectionHead' }, h('span', null, 'Move'), h('span', null, nudgeStep + 'px')),
              // THE FOUR DIRECTIONS IN ONE ROW. A cross is the gesture a gamepad has,
              // not the one a toolbar has: four buttons side by side read as "move",
              // and the row is one line in a 296px bar instead of a 3x3 block.
              h('div', { className: 'dsc-nudgeRow', 'data-canvas-nudge': 'true' },
                h('button', { type: 'button', 'data-canvas-nudge-dir': 'left', disabled: busy, title: 'Move left', onClick: () => nudgeLayer(-nudgeStep, 0) }, '\u2190'),
                h('button', { type: 'button', 'data-canvas-nudge-dir': 'up', disabled: busy, title: 'Move up', onClick: () => nudgeLayer(0, -nudgeStep) }, '\u2191'),
                h('button', { type: 'button', 'data-canvas-nudge-dir': 'down', disabled: busy, title: 'Move down', onClick: () => nudgeLayer(0, nudgeStep) }, '\u2193'),
                h('button', { type: 'button', 'data-canvas-nudge-dir': 'right', disabled: busy, title: 'Move right', onClick: () => nudgeLayer(nudgeStep, 0) }, '\u2192'),
                h('span', { className: 'dsc-spacer' }),
                [1, 10].map((step) => h('button', {
                  key: 'step-' + step,
                  type: 'button',
                  className: 'dsc-mini',
                  'data-canvas-step': String(step),
                  'data-on': nudgeStep === step ? 'true' : 'false',
                  style: { width: 'auto', padding: '0 8px', height: '26px' },
                  onClick: () => setNudgeStep(step),
                }, step + 'px')),
              ),
            ),
            h('div', { className: 'dsc-section', 'data-canvas-size': 'true' },
              h('div', { className: 'dsc-sectionHead' }, h('span', null, 'Size'), h('span', null, selectedBox ? Math.round(selectedBox.w) + ' \u00d7 ' + Math.round(selectedBox.h) + ' as laid out' : '')),
              h('div', { className: 'dsc-row2' },
                h('span', { className: 'dsc-fieldLabel' }, 'Width'),
                h('input', {
                  className: 'dsc-num',
                  type: 'number',
                  min: 8,
                  'data-canvas-size-input': 'w',
                  disabled: busy,
                  value: Math.round(typeof selectedNode.w === 'number' ? selectedNode.w : selectedBox ? selectedBox.w : 0),
                  onChange: (event) => sizeLayer('w', event.target.value),
                  title: 'A number, or type over a hug to give it one',
                }),
                h('input', {
                  className: 'dsc-num',
                  type: 'number',
                  min: 8,
                  'data-canvas-size-input': 'h',
                  disabled: busy || selectedNode.kind === 'text',
                  value: Math.round(typeof selectedNode.h === 'number' ? selectedNode.h : selectedBox ? selectedBox.h : 0),
                  onChange: (event) => sizeLayer('h', event.target.value),
                  title: selectedNode.kind === 'text' ? 'A text layer\u2019s height is what its words measure' : 'Height in design pixels',
                }),
              ),
              h('div', { className: 'dsc-row2' },
                h('span', { className: 'dsc-fieldLabel' }, 'Scale'),
                [0.5, 0.9, 1.1, 2].map((factor) => h('button', {
                  key: 'scale-' + factor,
                  type: 'button',
                  className: 'dsc-mini',
                  'data-canvas-scale': String(factor),
                  disabled: busy,
                  style: { width: 'auto', padding: '0 7px', height: '22px' },
                  title: 'Multiply the size by ' + factor,
                  onClick: () => scaleLayer(factor),
                }, '\u00d7' + factor)),
              ),
            ),
            h('div', { className: 'dsc-section', 'data-canvas-frame': 'true' },
              h('div', { className: 'dsc-sectionHead' }, h('span', null, 'Rotate') , h('span', null, (typeof selectedNode.rotate === 'number' ? selectedNode.rotate : 0) + '\u00b0')),
              h('div', { className: 'dsc-row2' },
                h('input', {
                  className: 'dsc-slider',
                  type: 'range',
                  min: -180,
                  max: 180,
                  step: 1,
                  'data-canvas-rotate': 'true',
                  disabled: busy,
                  value: typeof selectedNode.rotate === 'number' ? selectedNode.rotate : 0,
                  onChange: (event) => rotateLayer(Number(event.target.value)),
                }),
                h('button', { type: 'button', className: 'dsc-mini', style: { width: 'auto', padding: '0 7px', height: '22px' }, disabled: busy, title: 'Back to 0\u00b0', 'data-canvas-rotate-reset': 'true', onClick: () => rotateLayer(0) }, '0\u00b0'),
              ),
              h('div', { className: 'dsc-row2' },
                h('span', { className: 'dsc-fieldLabel' }, 'Opacity'),
                h('input', {
                  className: 'dsc-slider',
                  type: 'range',
                  min: 0,
                  max: 1,
                  step: 0.05,
                  'data-canvas-opacity': 'true',
                  disabled: busy,
                  value: typeof selectedNode.opacity === 'number' ? selectedNode.opacity : 1,
                  onChange: (event) => opacityLayer(Number(event.target.value)),
                }),
                h('span', { className: 'dsc-rowMeta', style: { width: '34px', textAlign: 'right' } }, Math.round((typeof selectedNode.opacity === 'number' ? selectedNode.opacity : 1) * 100) + '%'),
              ),
            ),
            h('div', { className: 'dsc-section', 'data-canvas-colors': 'true' },
              h('div', { className: 'dsc-sectionHead' }, h('span', null, 'Colour'), h('span', null, targets.length > 0 ? targets.length + ' target(s)' : 'none')),
              targets.length === 0
                ? h('p', { className: 'dsc-rowMeta' }, 'This kind paints nothing it owns - an image or an SVG document keeps its own colours.')
                : targets.map((target) =>
                    h('div', { key: target.key, className: 'dsc-row2', 'data-canvas-color-row': target.key },
                      h('span', { className: 'dsc-fieldLabel' }, target.label),
                      h('input', {
                        className: 'dsc-colorInput',
                        type: 'color',
                        'data-canvas-color': target.key,
                        disabled: busy,
                        value: paintColorOf(target.paint) ?? '#000000',
                        onChange: (event) => colorLayer(target.key, event.target.value),
                      }),
                      h('div', { className: 'dsc-swatches' },
                        designColors.slice(0, 8).map((color, index) => h('button', {
                          key: 'swatch-' + index,
                          type: 'button',
                          className: 'dsc-swatch',
                          'data-canvas-swatch': color,
                          'data-active': paintColorOf(target.paint) === paintColorOf(color) ? 'true' : 'false',
                          style: { background: color },
                          title: color,
                          disabled: busy,
                          onClick: () => colorLayer(target.key, color),
                        })),
                      ),
                    ),
                  ),
            ),
          )

      const inspectPane = h(
        'div',
        { className: 'dsc-pane', 'data-canvas-pane': 'inspect' },
        h('div', { className: 'dsc-paneScroll' }, transformPane),
      )

      const side = h(
        'aside',
        { className: 'dsc-side', 'data-canvas-side': 'true' },
        h('div', { className: 'dsc-sideHead' }, h('span', null, 'Canvas'), h('span', null, selected ? 'rev ' + selected.revision : '')),
        h('div', { className: 'dsc-sideTabs', 'data-canvas-side-tabs': 'true' },
          h('button', { type: 'button', className: 'dsc-sideTab', 'data-active': sideTab === 'design' ? 'true' : 'false', onClick: () => setSideTab('design') }, 'Design' + (lints && lints.length > 0 ? ' \u00b7 ' + lints.length : '')),
          h('button', { type: 'button', className: 'dsc-sideTab', 'data-active': sideTab === 'inspect' ? 'true' : 'false', onClick: () => setSideTab('inspect') }, 'Inspect'),
        ),
        sideTab === 'inspect' ? inspectPane : designPane,
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
        // The Excalidraw preview replaces the DESIGN surface visually while
        // leaving it mounted: the overlay is a sibling, so switching back is a
        // state change, the design keeps its zoom/selection/exports, and the
        // editor never sees a half-torn-down tree.
        surface === 'excalidraw' ? h(ExcalidrawSurface, {}) : null,
      )
    }

    /**
     * A node kind as a badge: three letters. The layer row lives in a 296px bar, and
     * the full kind is a `title` on the row, where a person who wants it can read it.
     */
    function layerKindBadge(kind) {
      const text = String(kind ?? '')
      return text.length > 3 ? text.slice(0, 3) : text
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
        // THE HOUSE GALLERY: the fastest start there is, because the preset, the
        // composition AND the look have already been chosen well. It sits above the
        // presets crossed with archetypes, which is the manual way to the same place.
        (state && Array.isArray(state.examples) && state.examples.length > 0)
          ? h('div', { 'data-canvas-examples': 'true' },
              h('p', { className: 'dsc-rowMeta', style: { margin: '2px 0 4px' } }, 'Start from a house example (' + state.examples.length + '):'),
              h('div', { className: 'dsc-gallery' },
                state.examples.map((entry) =>
                  h('button', {
                    key: entry.id,
                    type: 'button',
                    className: 'dsc-galleryItem',
                    disabled: busy,
                    'data-example': entry.id,
                    title: entry.intent,
                    onClick: () => onCreate(null, null, null, entry.id),
                  },
                    h('span', { className: 'dsc-galleryTitle' }, entry.title),
                    h('span', { className: 'dsc-galleryMeta' }, entry.preset + ' \u00b7 ' + entry.style),
                  ),
                ),
              ),
            )
          : null,
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
      ROUTES: { STATE_ROUTE, DOCUMENT_ROUTE, DELETE_ROUTE, PUBLISH_ROUTE, ASSET_ROUTE, QUEUE_ROUTE, REPORT_ROUTE, WORKSPACE_ASSET_ROUTE, ENGINE_ROUTE, EXCALIDRAW_JS_ROUTE, EXCALIDRAW_CSS_ROUTE },
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
      shortPath,
      nodeAtPath,
      layerTree,
      layerLabel,
      layerKindBadge,
      handlesFor,
      handlePoints,
      cursorFor,
      edgesAt,
      resizeOps,
      nudgeOps,
      sizeOps,
      rotateOps,
      opacityOps,
      paintTargets,
      paintColorOf,
      colorOps,
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
