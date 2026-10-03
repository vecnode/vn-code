/**
 * dsh-audio — browser half.
 *
 * TWO SURFACES, one package.
 *
 * 1. THE TAB TYPE for the pack's right bar (dsh-rightbar): WAV/RIFF, AIFF/AIFC
 *    and FLAC open as a WAVEFORM instead of the shipped preview's bare `<audio>`
 *    element - which for AIFF is not even a player in Chrome.
 *
 * The type registers at the `extension` band with the audio patterns, which is
 * what wins the address: the shipped document preview claims
 * `dsh-resource://file/**` at the `fallback` band, and an `extension`-band type
 * outranks a `fallback` one, so a `.wav` opens here while every other file type
 * keeps exactly the surface it had - MP3 and M4A included, which this package
 * deliberately does not claim and which the shipped preview still plays.
 * Nothing is disabled and no core row is touched.
 *
 * What the viewer adds, and why each part is here:
 *
 *   - a WAVEFORM: one row per track, an adaptive time ruler whose labels are
 *     MEASURED so they never collide, a min/max envelope with the RMS drawn
 *     inside it as a lighter band, and a linear or dBFS amplitude scale;
 *   - ZOOM THAT MOVES THE LAYOUT: the scrollable width is the file's real
 *     duration times the zoom (pixels per second), so a zoomed waveform stays
 *     scrollable to its edge and panning is the pane's own `scrollLeft`. The
 *     canvas that paints it is VIEWPORT-ANCHORED (`position: sticky; left: 0`),
 *     because a canvas cannot be 300000 px wide: the layout is the file, the
 *     canvas is the window onto it, and it repaints on scroll;
 *   - a PEAK PYRAMID, built once from the samples and drawn for ever after:
 *     drawing a waveform from raw samples is a per-frame rescan of the file,
 *     drawing it from peaks is a memory read. Level 0 is one bucket per 256
 *     samples and every level above it groups four buckets of the level below;
 *   - DRAG TO SELECT a time range (with its own duration, peak and RMS in the
 *     status line), a click to seek, and playback with the playhead driven by
 *     the AudioContext clock rather than a CSS animation;
 *   - honest failure, always a sentence: an unsupported codec names the codec,
 *     a truncated file draws what exists and says the rest is unknown (a
 *     missing tail is not silence), and a FLAC too big for the browser to
 *     decode says how big it is and what the way out is.
 *
 * HOW THE BYTES ARRIVE. This package is CLIENT-ONLY: it ships no route, no host
 * state and no path policy of its own, and its Node half is one no-op row whose
 * only job is to put this bundle in the boot graph. Bytes come from the
 * harness's own `workspaceFiles` remote - `readBytes` with a window for a
 * streaming pass and `readBytes` with EMPTY options for a whole file (the
 * namespace has no `readAll` at all; see the face comment below) - which already
 * resolves the path inside the conversation
 * workspace, refuses a symlink out of it, requires a regular file and enforces
 * its byte caps on the HOST side. Reading in WINDOWS is what lets a file far
 * past the 32 MiB single-read cap still draw a waveform: the decoder consumes
 * one window at a time and the samples are folded into the peak pyramid and
 * dropped, so a 2 GiB WAV costs a bounded amount of memory.
 *
 * WAV and AIFF/AIFC are decoded HERE, by a hand-written decoder: they are the
 * two the browser cannot both do (Chrome decodes WAV but not AIFF), and both
 * are simple containers. FLAC is decoded by the BROWSER (`decodeAudioData`),
 * which is why its path reads the whole file and is bounded by the harness's
 * own single-read cap - a bigger FLAC keeps its facts (a FLAC's STREAMINFO is
 * parsed here, so rate, channels, bit depth and length are known either way)
 * and says what the limit is.
 *
 * 2. THE AUDIO CONSOLE (alpha.3, section 13), which is not a tab at all: an
 *    **Audio** row in the left column's global-panel list, immediately ABOVE
 *    Plugins, that opens a modal listing this MACHINE's audio devices.
 *
 * A browser plays its audio wherever the OPERATING SYSTEM sends it, and a
 * machine with a headset, a monitor with speakers and a USB interface has three
 * answers to that - which is a question no browser surface in the harness
 * answered before this one. The console enumerates the devices
 * (`navigator.mediaDevices.enumerateDevices`), draws one CARD per device with
 * the browser's own label, marks where the system default actually points (from
 * the shared `groupId` Chromium reports for the alias and its target), lets a
 * person pick an output and an input, ROUTES the page's audio there where the
 * browser allows it, and plays a TEST TONE through the pick so the choice is
 * verified by ear rather than by faith - one frequency, one level, one channel.
 * The input side gets the same treatment: a live level meter off the chosen
 * microphone - analysed and never played back - with the browser's own report of
 * the capture it opened.
 *
 * THE ROUTING IS BEST EFFORT, AND THE UI SAYS SO - ONCE. Only Chromium 110+/
 * Opera 96+ expose `AudioContext.setSinkId`, which is the call that moves THIS
 * package's own playback (the waveform player and the tone share one
 * AudioContext); Chromium 49-109 and Safari 17.4+ route a media ELEMENT only, so
 * there the tone becomes a generated WAV in an `<audio>` element (the WAV ENCODER
 * in section 13 is the other direction of the decoder in section 3) and every
 * element already in the page follows the pick through
 * `HTMLMediaElement.setSinkId`; Firefox and older Safari expose neither, and
 * there the list is INFORMATION and the output section says in one sentence that
 * the system mixer is where the choice has to be made. The pick is remembered per
 * browser (`localStorage`), and a plugin that owns its own audio graph can read
 * it from the `audioDevices` service this package provides.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, URL, Blob, atob, navigator, Audio */
window.__ModuleLoader__.load({
  id: 'dsh-audio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** This implementation's identity in the tab system, and its slot key. */
    const TYPE_ID = 'dsh-audio'
    /** The tab kind this package owns. */
    const KIND = 'audio'
    /** Version marker shown in the toolbar, so a loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.4'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_PREFIX = 'dsh-resource://file/'
    const SESSION_SEGMENT = 'session/'
    /** The keyed seats every tab type occupies in the right bar. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** The Remote namespace this package reads bytes through. */
    const REMOTE_NAMESPACE = 'remote.workspaceFiles'

    /**
     * The file suffixes this type claims, and the media type each one is read
     * as. Three families on purpose: WAV/RIFF and AIFF/AIFC (the hand-written
     * decoder) and FLAC (the browser's). MP3, M4A/AAC and Ogg are NOT claimed -
     * the shipped preview already plays those through its own element, and a
     * waveform for a browser-decoded lossy file is a fidelity claim this
     * package does not need to make.
     */
    const MEDIA_TYPES = {
      wav: 'audio/wav',
      wave: 'audio/wav',
      aif: 'audio/aiff',
      aiff: 'audio/aiff',
      aifc: 'audio/aiff',
      flac: 'audio/flac',
    }
    /** The name the toolbar's format chip shows. */
    const FORMAT_NAMES = { wav: 'WAV', wave: 'WAVE', aif: 'AIFF', aiff: 'AIFF', aifc: 'AIFC', flac: 'FLAC' }

    // ---------------------------------------------------------------------
    // Caps and the peak pyramid's shape
    // ---------------------------------------------------------------------
    /** Level 0: one bucket per this many samples. */
    const BASE_BUCKET = 256
    /** Every level above groups this many buckets of the level below (exactly). */
    const LEVEL_FACTOR = 4
    /** Levels stop here; 256 * 4^9 is 67 M samples in one bucket. */
    const MAX_LEVELS = 10
    /** The first byte window asked for, and the smallest one accepted. */
    const WINDOW_START = 2 * 1024 * 1024
    const WINDOW_FLOOR = 64 * 1024
    /**
     * The header probe: it starts here, grows by this factor, and stops at the
     * ceiling. It has to grow past ONE window because a chunk walk can be cut in
     * half by a window boundary - a WAV with a large LIST or ID3 chunk (embedded
     * cover art, say) before its `data` - and reading more is how the walk
     * reaches the audio instead of reporting a header it never finished.
     */
    const PROBE_START = 64 * 1024
    const PROBE_CEILING = 8 * 1024 * 1024
    const PROBE_GROWTH = 4
    /** Above this many bytes the decoded samples are not kept for playback. */
    const PLAYBACK_BYTES = 32 * 1024 * 1024
    /** ...and neither are they above this many samples in total. */
    const PLAYBACK_SAMPLES = 24 * 1024 * 1024
    /** A selection is measured from the samples up to this many of them. */
    const MEASURE_SAMPLES = 8 * 1024 * 1024
    /**
     * The layout's own ceiling, in CSS pixels. A browser refuses to lay out an
     * element wider than ~33.5 M px and silently clamps the scroll range, so the
     * zoom ladder's top rung is the file's: what fits. Zooming to individual
     * samples is what that leaves for a short file (or a short selection).
     */
    const MAX_CONTENT_PX = 16000000

    // ---------------------------------------------------------------------
    // Geometry and the zoom ladder
    // ---------------------------------------------------------------------
    /** The channel-label gutter, the time ruler, and one TRACK's row. */
    const GUTTER = 48
    const RULER_H = 24
    const TRACK_H = 76
    const TRACK_GAP = 6
    /**
     * The track height belongs to the READER: the bottom edge of any track is a
     * handle, and dragging it resizes EVERY track at once. One shared height on
     * purpose - a waveform is read across tracks, and a file whose tracks were
     * separately sized would no longer line up vertically.
     */
    const MIN_TRACK_H = 24
    const MAX_TRACK_H = 420
    /** How near a track's bottom edge a press counts as its resize handle. */
    const HANDLE_GRAB = 5
    /** Pixels per second: the ladder the +/- buttons walk. */
    const PPS_STEPS = [
      1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000,
    ]
    const MIN_PPS = PPS_STEPS[0]
    const MAX_PPS = PPS_STEPS[PPS_STEPS.length - 1]
    /** Free space Fit leaves, in CSS pixels. */
    const FIT_PADDING = 12
    /** The wheel's zoom factor per notch, and the amplitude gain's ladder. */
    const WHEEL_FACTOR = 1.3
    const GAIN_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16]
    /** The dBFS scale draws this range, top to bottom. */
    const DB_RANGE = 72
    /** Below this amplitude the dBFS scale's reading is the -inf floor. */
    const DB_FLOOR = 1e-4
    /** From this many pixels per sample upwards the samples are drawn as stems. */
    const STEM_PX_PER_SAMPLE = 3

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.dsa-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar, and every column's top band ends in the
   same hairline at y=76: the docking strip above a pane is 38px and the
   conversation header is min-height:76px, which is why the Files tab, the
   editor, History, Diagrams, the PDF reader and the image viewer all use a 38px
   border-box header. */
.dsa-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;min-width:0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsa-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap}
.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsa-btn:disabled{opacity:.45;cursor:default}
.dsa-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsa-play{min-width:34px}
.dsa-unit{flex:none;min-width:74px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dsa-spacer{flex:1;min-width:0}
.dsa-meta{flex:0 1 auto;display:flex;align-items:center;gap:8px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dsa-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#666);font-family:ui-monospace,'Cascadia Code',Consolas,monospace}
.dsa-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-chip{flex:none;display:inline-flex;align-items:center;padding:0 6px;height:18px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsa-ver{flex:none;white-space:nowrap;opacity:.75}
/* The pane: the scroll viewport and the pan surface. Nothing here is ever
   transformed - the SPACER below carries the zoom as a real layout width. */
.dsa-scroll{flex:1;min-height:0;overflow:auto;position:relative;box-sizing:border-box;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.055));overscroll-behavior:contain}
.dsa-scroll:focus{outline:none}
.dsa-scroll:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary,#4f8cff)}
/* The file's real width at this zoom. The canvas is STICKY against it, so the
   canvas is never wider than the pane while the scroll range stays the file's. */
.dsa-spacerBox{position:relative}
.dsa-canvas{position:sticky;left:0;top:0;display:block;touch-action:none;cursor:crosshair}
.dsa-status{flex:none;display:flex;align-items:center;gap:12px;box-sizing:border-box;height:24px;padding:0 12px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dsa-statusSel{color:var(--dsw-alias-label-secondary,#666)}
.dsa-statusHint{margin-left:auto;opacity:.8}
.dsa-progress{flex:none;height:2px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsa-progressFill{height:100%;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width .12s linear}
.dsa-state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;line-height:18px;text-align:center}
.dsa-stateTitle{font-size:13px;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dsa-stateErr{color:var(--dsw-alias-state-error-primary,#d3382c);max-width:560px;word-break:break-word}
.dsa-stateNote{max-width:560px;font-size:11.5px;opacity:.85;word-break:break-word}
.dsa-row{display:flex;align-items:center;gap:6px}
.dsa-info{flex:none;max-height:38%;overflow:auto;box-sizing:border-box;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));font-size:11.5px;line-height:17px}
.dsa-infoRow{display:flex;gap:10px;min-width:0}
.dsa-infoKey{flex:none;width:104px;color:var(--dsw-alias-label-tertiary,#999)}
.dsa-infoVal{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#666);word-break:break-word;font-variant-numeric:tabular-nums}
/* --- the audio console (section 13): the left column's row, its seat, and the
   device console the pack's dialog frame puts on screen.

   The ROW draws only the glyph: the shell owns the button, its hover, its
   active state and its label, so this is one flex box and nothing else - which
   is what makes the row measure and behave exactly like the shipped Plugins row
   above/below it instead of roughly like it. */
.dsa-panelGlyph{display:inline-flex;align-items:center;justify-content:center}
/* The seat: the panel the row selects. It is behind the dialog, and it is also
   the whole surface when the pack's dialog bundle is not installed. */
.dsa-seat{height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.055))}
/* The console fills whatever holds it: the pack's lg dialog (1120x800 with no
   padding of its own) or the central column, inline. */
.dsa-console{flex:1;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;color:var(--dsw-alias-label-primary,#ececec);font-size:13px;line-height:1.5}
.dsa-consoleBar{flex:none;height:46px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 12px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22))}
.dsa-consoleTitle{font-size:14px;font-weight:600;white-space:nowrap}
.dsa-consoleStatus{flex:none;padding:8px 16px 0}
.dsa-consoleBody{flex:1;min-height:0;display:flex}
.dsa-consoleCol{flex:1;min-width:0;min-height:0;overflow:auto;box-sizing:border-box;padding:12px 16px 20px;display:flex;flex-direction:column;gap:16px}
.dsa-consoleCol + .dsa-consoleCol{border-left:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22))}
/* One section: a heading, an optional note, and whatever it draws. */
.dsa-devSection{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsa-devHead{display:flex;align-items:center;gap:8px;min-width:0}
.dsa-devTitle{flex:none;font-size:12.5px;font-weight:600}
.dsa-devCount{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsa-devNote{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere}
.dsa-warnState{color:var(--dsw-alias-state-error-primary,#e5534b)}
/* The cards. A grid that reflows, so a machine with eight outputs and a laptop
   with one both read as a list of things rather than a wall or a stripe. */
.dsa-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;min-width:0}
.dsa-card{display:flex;flex-direction:column;gap:2px;min-width:0;box-sizing:border-box;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:10px;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsa-card:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsa-card[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsa-card:disabled{cursor:default;opacity:.6}
.dsa-cardName{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-cardMeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-devEmpty{grid-column:1/-1;padding:10px;border:.5px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:11.5px;text-align:center}
/* The tone's controls, and the meter's bar. */
.dsa-toneRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsa-toneLabel{flex:none;width:72px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsa-toneHz{width:76px;height:24px;box-sizing:border-box;padding:0 6px;text-align:right;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px}
.dsa-toneHz:disabled{opacity:.5}
.dsa-toneRange{flex:1;min-width:110px;max-width:240px;accent-color:var(--dsw-alias-brand-primary,#4f8cff)}
.dsa-toneRange:disabled{opacity:.5}
.dsa-toneUnit{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums}
.dsa-btn.dsa-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4f8cff);color:#fff;font-weight:500}
.dsa-btn.dsa-primary:hover:not(:disabled){filter:brightness(1.08)}
.dsa-meter{flex:none;height:10px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));overflow:hidden}
.dsa-meterFill{height:100%;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width .06s linear}
.dsa-facts{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsa-factRow{display:flex;gap:10px;min-width:0;font-size:11.5px;line-height:17px}
.dsa-factKey{flex:none;width:104px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsa-factVal{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#b8b8b8);word-break:break-word;font-variant-numeric:tabular-nums}
`
    const CSS_TAG = 'dsh-audio/audio.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-audio'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // The Remote face, captured at activation
    //
    // Read through `ctx.get(REMOTE_NAMESPACE)`, the way dsh-image has to as
    // well: cordis only exposes a service as a property when the plugin's
    // `inject` names that service, and this plugin injects the NAMESPACE
    // (`remote.workspaceFiles`), never its carrier (`remote`). Writing
    // `ctx.remote.workspaceFiles` threw `cannot get property "remote" without
    // inject`, the guard below swallowed it into null, and every audio tab
    // reported that the harness exposed no workspaceFiles remote.
    //
    // `readBytes(scopeId, path, { offset, length }, signal)` reads a window and
    // `readBytes(scopeId, path, {}, signal)` reads the whole file; each resolves
    // to `{ ok: true, value }` or `{ ok: false, error }`, and rejects only for
    // an assembly fault. THERE IS NO `readAll` on this namespace (the generated
    // Remote declares `changes`, `list`, `read`, `readBytes` and `stat`), and
    // the whole-file path used to call one - which is why no FLAC could be
    // decoded. The payload's `data` is a `Uint8Array` and `bytesOf` accepts the
    // other shapes a carrier could use, so a window is never fed to `atob`.
    // ---------------------------------------------------------------------
    let workspaceFiles = null

    /** The host's own per-window ceiling, learned from a refusal (2 MiB by default). */
    let windowCap = WINDOW_START

    // =====================================================================
    // 1. Byte readers (pure)
    // =====================================================================
    /** Four ASCII characters at an offset, for a chunk id or a magic. */
    function asciiAt(bytes, offset, length) {
      let text = ''
      for (let index = 0; index < length; index += 1) {
        const code = bytes[offset + index]
        text += code === undefined ? '?' : String.fromCharCode(code)
      }
      return text
    }

    function u16le(bytes, offset) {
      return bytes[offset] | (bytes[offset + 1] << 8)
    }

    function u32le(bytes, offset) {
      return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    }

    function u16be(bytes, offset) {
      return (bytes[offset] << 8) | bytes[offset + 1]
    }

    function u32be(bytes, offset) {
      return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
    }

    function u24be(bytes, offset) {
      return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
    }

    function int16le(bytes, offset) {
      return ((bytes[offset] | (bytes[offset + 1] << 8)) << 16) >> 16
    }

    function int16be(bytes, offset) {
      return (((bytes[offset] << 8) | bytes[offset + 1]) << 16) >> 16
    }

    function int24le(bytes, offset) {
      return ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) << 8) >> 8
    }

    function int24be(bytes, offset) {
      return (((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]) << 8) >> 8
    }

    function int32le(bytes, offset) {
      return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
    }

    function int32be(bytes, offset) {
      return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    }

    /**
     * An 80-bit IEEE extended float, the only sample-rate encoding AIFF has.
     * @param bytes - the bytes.
     * @param offset - where the ten bytes start.
     * @returns the value in Hz (0 for the zero encoding).
     */
    function readExtended80(bytes, offset) {
      const exponentWord = u16be(bytes, offset)
      const sign = (exponentWord & 0x8000) === 0 ? 1 : -1
      const exponent = exponentWord & 0x7fff
      const mantissa = u32be(bytes, offset + 2) * 4294967296 + u32be(bytes, offset + 6)
      if (exponent === 0 && mantissa === 0) return 0
      return sign * mantissa * Math.pow(2, exponent - 16383 - 63)
    }

    // =====================================================================
    // 2. The companded laws (G.711), as tables
    // =====================================================================
    /** A-law: one byte in, a signed 16-bit level out. */
    function alawToLinear(value) {
      let sample = value ^ 0x55
      let magnitude = (sample & 0x0f) << 4
      const segment = (sample & 0x70) >> 4
      if (segment === 0) magnitude += 8
      else if (segment === 1) magnitude += 0x108
      else {
        magnitude += 0x108
        magnitude <<= segment - 1
      }
      return (sample & 0x80) !== 0 ? magnitude : -magnitude
    }

    /** mu-law: one byte in, a signed 16-bit level out. */
    function ulawToLinear(value) {
      const sample = ~value & 0xff
      let magnitude = ((sample & 0x0f) << 3) + 0x84
      magnitude <<= (sample & 0x70) >> 4
      return (sample & 0x80) !== 0 ? 0x84 - magnitude : magnitude - 0x84
    }

    /** The 256-entry table of one law, built once per process. */
    const LAW_TABLES = {}
    function lawTable(kind) {
      if (LAW_TABLES[kind] === undefined) {
        const table = new Float32Array(256)
        for (let index = 0; index < 256; index += 1) {
          const linear = kind === 'alaw' ? alawToLinear(index) : ulawToLinear(index)
          table[index] = linear / 32768
        }
        LAW_TABLES[kind] = table
      }
      return LAW_TABLES[kind]
    }

    // =====================================================================
    // 3. Containers: WAV/RIFF, AIFF/AIFC, FLAC
    //
    // Each parser is PURE and works on whatever prefix it was handed, so the
    // loader can grow the probe until a container parses. Every one of them
    // returns either `{ ok: true, ... }`, `{ ok: false, needsMore: true }` (the
    // prefix cut a header in half) or `{ ok: false, reason }` (the file is not
    // something this package can draw).
    // =====================================================================

    /** Codec tag names, so an unsupported WAV says WHICH codec it is. */
    const WAVE_TAGS = {
      0x0002: 'Microsoft ADPCM',
      0x0011: 'IMA ADPCM',
      0x0016: 'ITU G.723 ADPCM',
      0x0031: 'GSM 6.10',
      0x0050: 'MPEG Layer 2',
      0x0055: 'MPEG Layer 3',
      0x00ff: 'raw AAC',
      0x0161: 'Windows Media Audio v2',
      0x0162: 'Windows Media Audio Pro',
      0x0163: 'Windows Media Audio Lossless',
      0x2000: 'Dolby AC-3',
      0x2001: 'DTS',
      0x674f: 'Ogg Vorbis',
    }

    /** One codec name a person reads in the details panel and in a refusal. */
    const KIND_NAMES = {
      u8: 'PCM unsigned 8-bit',
      s8: 'PCM signed 8-bit',
      s16: 'PCM signed 16-bit',
      s24: 'PCM signed 24-bit',
      s32: 'PCM signed 32-bit',
      f32: 'IEEE float 32-bit',
      f64: 'IEEE float 64-bit',
      alaw: 'G.711 A-law',
      ulaw: 'G.711 mu-law',
    }

    /** The codec sentence for one decode descriptor. */
    function codecName(format) {
      const base = KIND_NAMES[format.kind] === undefined ? format.kind : KIND_NAMES[format.kind]
      if (format.kind === 'f32' || format.kind === 'f64' || format.kind === 'alaw' || format.kind === 'ulaw') return base
      return base + (format.endian === 'be' ? ' big-endian' : ' little-endian')
    }

    /**
     * The answer for a chunk that runs past the bytes in hand.
     *
     * Reading MORE is only worth offering when those bytes are a PREFIX of the
     * file. A prefix that IS the whole file has nothing more to give, and
     * answering `needsMore` there is what made a 20-byte `RIFF...WAVE` report
     * that "its header is larger than the 8 MiB this viewer reads": the caller
     * could not tell "waiting for more bytes" from "the file simply ends here".
     */
    function cutOff(reason, wholeFile) {
      return wholeFile === true ? { ok: false, reason: reason } : { ok: false, needsMore: true, reason: reason }
    }

    /**
     * The `fmt ` chunk of a WAVE file, including WAVE_FORMAT_EXTENSIBLE.
     * @returns a decode descriptor, or the refusal to report.
     */
    function parseWavFmt(bytes, body, size, wholeFile) {
      if (body + 16 > bytes.length) return cutOff('the fmt chunk was cut off', wholeFile)
      const tag = u16le(bytes, body)
      const channels = u16le(bytes, body + 2)
      const sampleRate = u32le(bytes, body + 4)
      const blockAlign = u16le(bytes, body + 12)
      const bits = u16le(bytes, body + 14)
      let validBits = bits
      let channelMask = 0
      let effective = tag
      let extensible = false
      if (tag === 0xfffe) {
        if (size < 40 || body + 40 > bytes.length) {
          return cutOff('the WAVE_FORMAT_EXTENSIBLE fmt chunk was cut off', wholeFile)
        }
        extensible = true
        validBits = u16le(bytes, body + 18)
        channelMask = u32le(bytes, body + 20)
        effective = u16le(bytes, body + 24)
      }
      if (channels < 1 || channels > 64) return { ok: false, reason: 'it claims ' + channels + ' channels' }
      if (!(sampleRate > 0)) return { ok: false, reason: 'it claims a sample rate of 0' }
      let kind = ''
      if (effective === 1) {
        if (bits === 8) kind = 'u8'
        else if (bits === 16) kind = 's16'
        else if (bits === 24) kind = 's24'
        else if (bits === 32) kind = 's32'
      } else if (effective === 3) {
        if (bits === 32) kind = 'f32'
        else if (bits === 64) kind = 'f64'
      } else if (effective === 6 && bits === 8) kind = 'alaw'
      else if (effective === 7 && bits === 8) kind = 'ulaw'
      if (kind === '') {
        const named = WAVE_TAGS[effective] === undefined ? 'codec tag 0x' + effective.toString(16) : WAVE_TAGS[effective]
        const bitsNote = effective === 1 || effective === 3 ? ' at ' + bits + ' bits per sample' : ''
        return { ok: false, reason: 'its audio is ' + named + bitsNote + ', which this viewer does not decode' }
      }
      const bytesPerSample = bits === 1 ? 1 : Math.ceil(bits / 8)
      const frameBytes = channels * bytesPerSample
      // `blockAlign` is the file's own frame stride, and it is what the decoder
      // walks with. A value smaller than one frame cannot be a stride at all:
      // walking it reads a channel out of the NEXT frame's bytes (silently wrong
      // samples), an 8-bit stereo file reads `undefined` into the samples, and a
      // float file throws a raw DataView RangeError at the last frame. Refused by
      // name instead, so the viewer says what is wrong with the file.
      if (blockAlign > 0 && blockAlign < frameBytes) {
        return {
          ok: false,
          reason:
            'its fmt chunk says ' +
            channels +
            ' channel(s) at ' +
            bits +
            ' bits, which is a frame of ' +
            frameBytes +
            ' bytes, but it declares a block align of ' +
            blockAlign,
        }
      }
      return {
        ok: true,
        kind: kind,
        endian: 'le',
        channels: channels,
        sampleRate: sampleRate,
        bits: bits,
        validBits: validBits,
        channelMask: channelMask,
        extensible: extensible,
        tag: effective,
        blockAlign: blockAlign > 0 ? blockAlign : frameBytes,
      }
    }

    /** The BWF `bext` chunk's first fields, which is where a broadcast's take lives. */
    function parseBext(bytes, body, size) {
      const text = (offset, length) => {
        let value = ''
        for (let index = 0; index < length; index += 1) {
          const code = bytes[body + offset + index]
          if (code === undefined || code === 0) break
          value += String.fromCharCode(code)
        }
        return value.trim()
      }
      if (size < 348 || body + 348 > bytes.length) return undefined
      return {
        description: text(0, 256),
        originator: text(256, 32),
        originatorReference: text(288, 32),
        originationDate: text(320, 10),
        originationTime: text(330, 8),
        timeReferenceLow: u32le(bytes, body + 338),
        timeReferenceHigh: u32le(bytes, body + 342),
      }
    }

    /** A 64-bit little-endian integer as a Number, for an RF64 `ds64` field. */
    function u64le(bytes, offset) {
      return u32le(bytes, offset) + u32le(bytes, offset + 4) * 4294967296
    }

    /** The `LIST`/`INFO` tags a person recognizes (the rest are ignored). */
    function parseListInfo(bytes, body, size, metadata) {
      if (size < 4 || asciiAt(bytes, body, 4) !== 'INFO') return
      let offset = body + 4
      const end = Math.min(bytes.length, body + size)
      while (offset + 8 <= end) {
        const id = asciiAt(bytes, offset, 4)
        const length = u32le(bytes, offset + 4)
        const value = []
        const from = offset + 8
        const to = Math.min(end, from + length)
        for (let index = from; index < to; index += 1) {
          const code = bytes[index]
          if (code === 0) break
          value.push(String.fromCharCode(code))
        }
        const text = value.join('').trim()
        if (text !== '') {
          if (id === 'INAM') metadata.title = text
          else if (id === 'IART') metadata.artist = text
          else if (id === 'IPRD') metadata.album = text
          else if (id === 'ICRD') metadata.date = text
          else if (id === 'IGNR') metadata.genre = text
          else if (id === 'ISFT') metadata.software = text
          else if (id === 'ICMT') metadata.comment = text
          else if (id === 'ITRK') metadata.track = text
        }
        offset = from + length + (length & 1)
      }
    }

    /**
     * A WAVE (RIFF) file.
     * @param bytes - the prefix (or the whole file).
     * @param totalBytes - the file's real size, for the truncation check.
     * @param wholeFile - whether `bytes` is the ENTIRE file, which is what turns
     *   a walk that ran out of bytes from "read more" into a verdict.
     */
    function parseWav(bytes, totalBytes, wholeFile) {
      // RF64 and BW64 are the same container with 64-bit sizes, written by
      // anything that records past 4 GiB; the walk below is identical and the
      // real size of the data chunk comes from the `ds64` chunk.
      const magic = bytes.length >= 4 ? asciiAt(bytes, 0, 4) : ''
      const isRf64 = magic === 'RF64' || magic === 'BW64'
      if (bytes.length < 12 || (isRf64 ? false : magic !== 'RIFF') || asciiAt(bytes, 8, 4) !== 'WAVE') {
        return { ok: false, reason: 'not a RIFF/WAVE file' }
      }
      const metadata = {}
      let format = null
      let dataOffset = -1
      let declaredDataBytes = 0
      let ds64DataBytes = 0
      let offset = 12
      let sawEnd = false
      while (true) {
        if (offset + 8 > bytes.length) {
          sawEnd = true
          break
        }
        const id = asciiAt(bytes, offset, 4)
        const size = u32le(bytes, offset + 4)
        const body = offset + 8
        if (id === 'fmt ') {
          const parsed = parseWavFmt(bytes, body, size, wholeFile)
          if (!parsed.ok) return parsed
          format = parsed
        } else if (id === 'data') {
          dataOffset = body
          // An RF64 says 0xFFFFFFFF here and puts the truth in `ds64`.
          declaredDataBytes = size === 0xffffffff && ds64DataBytes > 0 ? ds64DataBytes : size
          break
        } else if (id === 'fact') {
          if (body + 4 <= bytes.length) metadata.factFrames = u32le(bytes, body)
        } else if (id === 'ds64') {
          if (body + 28 <= bytes.length) {
            ds64DataBytes = u64le(bytes, body + 16)
            metadata.ds64 = { riffSize: u64le(bytes, body + 8), dataSize: ds64DataBytes, sampleCount: u64le(bytes, body + 24) }
          }
        } else if (id === 'bext') {
          const broadcast = parseBext(bytes, body, size)
          if (broadcast !== undefined) metadata.broadcast = broadcast
        } else if (id === 'LIST') {
          parseListInfo(bytes, body, size, metadata)
        } else if (id === 'ID3 ' || id === 'id3 ') {
          metadata.id3 = true
        }
        // A chunk with no body at all - a zero-size `junk`, an empty `LIST` - is
        // legal and is exactly 8 bytes of header, so the walk has to step OVER
        // it. It used to STOP here, which made any file carrying one unreadable:
        // the walk ended before the `data` chunk, the parse answered "no data
        // chunk ... so far", the probe re-read the whole file looking for one and
        // the viewer then blamed a header it had never reached.
        const next = body + size + (size & 1)
        if (next <= offset) {
          sawEnd = true
          break
        }
        offset = next
      }
      if (format === null) {
        return sawEnd && wholeFile !== true
          ? { ok: false, needsMore: true, reason: 'no fmt chunk was found in the bytes read so far' }
          : { ok: false, reason: 'it has no fmt chunk' }
      }
      if (dataOffset < 0) {
        return sawEnd && wholeFile !== true
          ? { ok: false, needsMore: true, reason: 'no data chunk was found in the bytes read so far' }
          : { ok: false, reason: 'it has no data chunk' }
      }
      const available = Math.max(0, (Number.isFinite(totalBytes) ? totalBytes : bytes.length) - dataOffset)
      // A streamed or partly written WAV says 0 (or too much) in the data
      // chunk's size field. What the FILE actually holds is the honest answer,
      // and the truncation is reported rather than guessed.
      const promised = declaredDataBytes > 0 ? declaredDataBytes : available
      const dataBytes = Math.max(0, Math.min(promised, available))
      const frames = Math.floor(dataBytes / format.blockAlign)
      return {
        ok: true,
        container: isRf64 ? 'WAVE (RF64)' : 'WAVE (RIFF)',
        format: format,
        codec: codecName(format),
        channels: format.channels,
        sampleRate: format.sampleRate,
        bits: format.bits,
        blockAlign: format.blockAlign,
        dataOffset: dataOffset,
        dataBytes: dataBytes,
        declaredDataBytes: declaredDataBytes,
        frames: frames,
        duration: format.sampleRate > 0 ? frames / format.sampleRate : 0,
        truncated: declaredDataBytes > 0 && declaredDataBytes > available,
        metadata: metadata,
      }
    }

    /** A compression type this package cannot decode, named. */
    const AIFC_TYPES = {
      ima4: 'IMA 4:1 ADPCM',
      MAC3: 'MACE 3:1',
      MAC6: 'MACE 6:1',
      GSM: 'GSM 6.10',
      'G.722': 'ITU G.722 ADPCM',
      'G.726': 'ITU G.726 ADPCM',
      'G.728': 'ITU G.728 LD-CELP',
      Qclp: 'Qualcomm PureVoice',
      mp3: 'MPEG Layer 3',
      'aac ': 'AAC',
    }

    /** The `COMM` chunk of an AIFF/AIFC file. */
    function parseAiffComm(bytes, body, size, formType, wholeFile) {
      if (body + 18 > bytes.length) return cutOff('the COMM chunk was cut off', wholeFile)
      const channels = int16be(bytes, body)
      const declaredFrames = u32be(bytes, body + 2)
      const sampleSize = int16be(bytes, body + 6)
      const sampleRate = readExtended80(bytes, body + 8)
      let compression = ''
      if (formType === 'AIFC') {
        if (body + 22 > bytes.length) return cutOff('the COMM chunk was cut off', wholeFile)
        compression = asciiAt(bytes, body + 18, 4)
      }
      if (channels < 1 || channels > 64) return { ok: false, reason: 'it claims ' + channels + ' channels' }
      if (!(sampleRate > 0)) return { ok: false, reason: 'it claims a sample rate of 0' }
      let kind = ''
      let endian = 'be'
      const type = compression === '' ? 'NONE' : compression
      if (type === 'NONE') {
        if (sampleSize === 8) kind = 's8'
        else if (sampleSize === 16) kind = 's16'
        else if (sampleSize === 24) kind = 's24'
        else if (sampleSize === 32) kind = 's32'
      } else if (type === 'sowt' || type === 'SOWT') {
        endian = 'le'
        if (sampleSize === 16) kind = 's16'
        else if (sampleSize === 8) kind = 's8'
        else if (sampleSize === 24) kind = 's24'
        else if (sampleSize === 32) kind = 's32'
      } else if (type === 'fl32' || type === 'FL32') kind = 'f32'
      else if (type === 'fl64' || type === 'FL64') kind = 'f64'
      else if (type === 'alaw' || type === 'ALAW') kind = 'alaw'
      else if (type === 'ulaw' || type === 'ULAW') kind = 'ulaw'
      if (kind === '') {
        const named = AIFC_TYPES[type] === undefined ? 'compression type "' + type + '"' : AIFC_TYPES[type]
        return { ok: false, reason: 'its audio is ' + named + ', which this viewer does not decode' }
      }
      const bytesPerSample = sampleSize === 1 ? 1 : Math.ceil(sampleSize / 8)
      return {
        ok: true,
        kind: kind,
        endian: endian,
        channels: channels,
        sampleRate: sampleRate,
        bits: sampleSize,
        compression: type,
        blockAlign: channels * bytesPerSample,
        declaredFrames: declaredFrames,
      }
    }

    /**
     * An AIFF or AIFC (IFF FORM) file.
     * @param bytes - the prefix (or the whole file).
     * @param totalBytes - the file's real size, for the truncation check.
     * @param wholeFile - whether `bytes` is the ENTIRE file (see `parseWav`).
     */
    function parseAiff(bytes, totalBytes, wholeFile) {
      if (bytes.length < 12 || asciiAt(bytes, 0, 4) !== 'FORM') return { ok: false, reason: 'not an IFF FORM' }
      const formType = asciiAt(bytes, 8, 4)
      if (formType !== 'AIFF' && formType !== 'AIFC') return { ok: false, reason: 'an IFF FORM of type ' + formType }
      const metadata = {}
      let format = null
      let sound = null
      let offset = 12
      let sawEnd = false
      while (true) {
        if (offset + 8 > bytes.length) {
          sawEnd = true
          break
        }
        const id = asciiAt(bytes, offset, 4)
        const size = u32be(bytes, offset + 4)
        const body = offset + 8
        if (id === 'COMM') {
          const parsed = parseAiffComm(bytes, body, size, formType, wholeFile)
          if (!parsed.ok) return parsed
          format = parsed
        } else if (id === 'SSND') {
          if (body + 8 > bytes.length) {
            sawEnd = true
            break
          }
          const soundOffset = u32be(bytes, body)
          const declared = size >= 8 ? size - 8 - soundOffset : 0
          sound = { dataOffset: body + 8 + soundOffset, declaredDataBytes: declared }
          // SSND is the audio itself, normally last: nothing after it is a chunk.
          break
        } else if (id === 'NAME') {
          metadata.title = textAt(bytes, body, Math.min(size, bytes.length - body))
        } else if (id === 'AUTH') {
          metadata.artist = textAt(bytes, body, Math.min(size, bytes.length - body))
        } else if (id === 'ANNO') {
          metadata.comment = textAt(bytes, body, Math.min(size, bytes.length - body))
        } else if (id === '(c) ') {
          metadata.copyright = textAt(bytes, body, Math.min(size, bytes.length - body))
        }
        // The same zero-size-chunk step-over as the WAV walk above.
        const next = body + size + (size & 1)
        if (next <= offset) {
          sawEnd = true
          break
        }
        offset = next
      }
      if (format === null) {
        return sawEnd && wholeFile !== true
          ? { ok: false, needsMore: true, reason: 'no COMM chunk was found in the bytes read so far' }
          : { ok: false, reason: 'it has no COMM chunk' }
      }
      if (sound === null) {
        return sawEnd && wholeFile !== true
          ? { ok: false, needsMore: true, reason: 'no SSND chunk was found in the bytes read so far' }
          : { ok: false, reason: 'it has no SSND chunk (an AIFF with no audio in it)' }
      }
      const available = Math.max(0, (Number.isFinite(totalBytes) ? totalBytes : bytes.length) - sound.dataOffset)
      const promised = sound.declaredDataBytes > 0 ? sound.declaredDataBytes : available
      const dataBytes = Math.max(0, Math.min(promised, available))
      // COMM's own frame count is the AIFF's authority on length; a file that
      // was cut short reports both numbers rather than one wrong one.
      const bytesFrames = Math.floor(dataBytes / format.blockAlign)
      const frames = format.declaredFrames > 0 ? Math.min(format.declaredFrames, bytesFrames) : bytesFrames
      return {
        ok: true,
        container: formType === 'AIFC' ? 'AIFC (IFF FORM)' : 'AIFF (IFF FORM)',
        format: format,
        codec: codecName(format) + (format.compression === 'sowt' ? ' (sowt)' : ''),
        channels: format.channels,
        sampleRate: format.sampleRate,
        bits: format.bits,
        blockAlign: format.blockAlign,
        dataOffset: sound.dataOffset,
        dataBytes: dataBytes,
        declaredDataBytes: format.declaredFrames * format.blockAlign,
        frames: frames,
        duration: format.sampleRate > 0 ? frames / format.sampleRate : 0,
        truncated: frames < format.declaredFrames,
        metadata: metadata,
      }
    }

    /** A NUL-terminated run of ASCII at an offset (an IFF text chunk). */
    function textAt(bytes, offset, length) {
      let text = ''
      for (let index = 0; index < length; index += 1) {
        const code = bytes[offset + index]
        if (code === undefined || code === 0) break
        text += String.fromCharCode(code)
      }
      return text.trim()
    }

    /** The Vorbis comment block a FLAC carries as metadata. */
    function parseVorbisComment(bytes, body, size, metadata) {
      const end = Math.min(bytes.length, body + size)
      if (body + 4 > end) return
      const vendorLength = u32le(bytes, body)
      let offset = body + 4 + vendorLength
      if (offset + 4 > end) return
      const count = u32le(bytes, offset)
      offset += 4
      const wanted = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', DATE: 'date', GENRE: 'genre', TRACKNUMBER: 'track', COMMENT: 'comment' }
      for (let index = 0; index < count && index < 64; index += 1) {
        if (offset + 4 > end) return
        const length = u32le(bytes, offset)
        const from = offset + 4
        const to = Math.min(end, from + length)
        if (length > 0 && from < end) {
          const text = textAt(bytes, from, to - from)
          const cut = text.indexOf('=')
          if (cut > 0) {
            const key = text.slice(0, cut).toUpperCase()
            if (wanted[key] !== undefined && metadata[wanted[key]] === undefined) metadata[wanted[key]] = text.slice(cut + 1)
          }
        }
        offset = from + length
      }
    }

    /**
     * A FLAC stream's own facts, from the STREAMINFO metadata block: the sample
     * rate, channel count, bit depth and TOTAL sample count are all declared in
     * the file's first 42 bytes, so this viewer can state a FLAC's length even
     * when it is too big for the browser's decoder.
     * @param bytes - the prefix (or the whole file).
     * @param wholeFile - whether `bytes` is the ENTIRE file (see `parseWav`).
     */
    function parseFlacInfo(bytes, wholeFile) {
      if (bytes.length < 4 || asciiAt(bytes, 0, 4) !== 'fLaC') return { ok: false, reason: 'not a FLAC stream' }
      let offset = 4
      let stream = null
      const metadata = {}
      while (offset + 4 <= bytes.length) {
        const header = bytes[offset]
        const last = (header & 0x80) !== 0
        const type = header & 0x7f
        const size = u24be(bytes, offset + 1)
        const body = offset + 4
        if (type === 0) {
          if (body + 34 > bytes.length) {
            return cutOff('the STREAMINFO block was cut off', wholeFile)
          }
          const high = u32be(bytes, body + 10)
          const low = u32be(bytes, body + 14)
          stream = {
            minBlockSize: u16be(bytes, body),
            maxBlockSize: u16be(bytes, body + 2),
            sampleRate: high >>> 12,
            channels: ((high >>> 9) & 7) + 1,
            bits: ((high >>> 4) & 31) + 1,
            totalSamples: (high & 15) * 4294967296 + low,
          }
        } else if (type === 4) {
          parseVorbisComment(bytes, body, size, metadata)
        }
        if (last) break
        // A zero-size metadata block is 4 bytes of header and nothing else; step
        // over it rather than stopping the walk (see the WAV walk above).
        const next = body + size
        if (next <= offset) break
        offset = next
      }
      if (stream === null) return { ok: false, reason: 'it carries no STREAMINFO block' }
      if (!(stream.sampleRate > 0)) return { ok: false, reason: 'it claims a sample rate of 0' }
      const frames = stream.totalSamples > 0 ? stream.totalSamples : 0
      return {
        ok: true,
        container: 'FLAC',
        codec: 'FLAC (browser-decoded)',
        format: { kind: 'flac', endian: 'le', channels: stream.channels, sampleRate: stream.sampleRate, bits: stream.bits, blockAlign: 0, compressed: true },
        channels: stream.channels,
        sampleRate: stream.sampleRate,
        bits: stream.bits,
        blockAlign: 0,
        dataOffset: 0,
        dataBytes: bytes.length,
        declaredDataBytes: 0,
        frames: frames,
        duration: frames > 0 ? frames / stream.sampleRate : 0,
        truncated: false,
        metadata: metadata,
        stream: stream,
      }
    }

    /**
     * Which container a prefix is, by its own magic. WAV and AIFF are tried
     * first because they are the ones this package decodes itself; FLAC is
     * tried last and only for a `fLaC` magic, so a FLAC prefix never falls into
     * a RIFF walk.
     * @param bytes - the prefix.
     * @param totalBytes - the file's real size.
     * @param wholeFile - whether `bytes` is the ENTIRE file (see `parseWav`).
     */
    function parseContainer(bytes, totalBytes, wholeFile) {
      if (bytes.length >= 12 && asciiAt(bytes, 8, 4) === 'WAVE') {
        const magic = asciiAt(bytes, 0, 4)
        if (magic === 'RIFF' || magic === 'RF64' || magic === 'BW64') return parseWav(bytes, totalBytes, wholeFile)
      }
      if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'FORM') return parseAiff(bytes, totalBytes, wholeFile)
      if (bytes.length >= 4 && asciiAt(bytes, 0, 4) === 'fLaC') return parseFlacInfo(bytes, wholeFile)
      return { ok: false, reason: 'its first bytes are not a RIFF/WAVE, an IFF FORM or a FLAC stream' }
    }

    // =====================================================================
    // 4. The decoder (pure)
    // =====================================================================
    /** The divisor that maps an integer sample to [-1, 1). */
    const INT_SCALES = { s8: 128, s16: 32768, s24: 8388608, s32: 2147483648 }

    /**
     * Decode one block of interleaved PCM.
     *
     * `bytes` must start on a frame boundary and be a whole number of frames
     * long (the loader guarantees both, which is what makes a windowed decode
     * of a huge file produce the same samples as a single whole-file decode).
     * `format.blockAlign` is a whole frame's stride and at least one frame wide:
     * the parsers REFUSE a file that declares less, so no read here can walk out
     * of the window behind a malformed header.
     *
     * @returns `{ channels: Float32Array[], frames }`.
     */
    function decodePcm(format, bytes) {
      const channels = format.channels
      const frames = format.blockAlign > 0 ? Math.floor(bytes.length / format.blockAlign) : 0
      const out = []
      for (let index = 0; index < channels; index += 1) out.push(new Float32Array(frames))
      if (frames === 0) return { channels: out, frames: frames }
      const step = format.blockAlign
      const kind = format.kind
      // Every integer path is plain byte arithmetic (a DataView call per sample
      // is measurable at 16 M samples); only the IEEE floats need a view.
      if (kind === 'u8' || kind === 's8') {
        const signed = kind === 's8'
        let offset = 0
        for (let frame = 0; frame < frames; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            const value = bytes[offset + channel]
            out[channel][frame] = signed ? ((value << 24) >> 24) / 128 : (value - 128) / 128
          }
          offset += step
        }
        return { channels: out, frames: frames }
      }
      if (kind === 's16' || kind === 's24' || kind === 's32') {
        const scale = INT_SCALES[kind]
        const width = kind === 's16' ? 2 : kind === 's24' ? 3 : 4
        const read = kind === 's16' ? (format.endian === 'be' ? int16be : int16le) : kind === 's24' ? (format.endian === 'be' ? int24be : int24le) : format.endian === 'be' ? int32be : int32le
        let offset = 0
        for (let frame = 0; frame < frames; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            out[channel][frame] = read(bytes, offset + channel * width) / scale
          }
          offset += step
        }
        return { channels: out, frames: frames }
      }
      if (kind === 'alaw' || kind === 'ulaw') {
        const table = lawTable(kind)
        let offset = 0
        for (let frame = 0; frame < frames; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) out[channel][frame] = table[bytes[offset + channel]]
          offset += step
        }
        return { channels: out, frames: frames }
      }
      if (kind === 'f32' || kind === 'f64') {
        const width = kind === 'f32' ? 4 : 8
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const big = format.endian === 'be'
        let offset = 0
        for (let frame = 0; frame < frames; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            const at = offset + channel * width
            out[channel][frame] = kind === 'f32' ? view.getFloat32(at, !big) : view.getFloat64(at, !big)
          }
          offset += step
        }
        return { channels: out, frames: frames }
      }
      throw new Error('no decoder for ' + kind)
    }

    // =====================================================================
    // 5. The peak pyramid (pure)
    //
    // Level 0 is one bucket per BASE_BUCKET samples and holds (min, max, rms)
    // per channel; every level above groups LEVEL_FACTOR buckets of the level
    // below, exactly: the RMS of a parent is the root of the mean of its
    // children's squares, so the pyramid's numbers are the samples' numbers and
    // not an approximation of them. The client picks the level from the current
    // pixels-per-second, so zooming out changes WHICH level is read and never
    // how many samples are walked.
    // =====================================================================
    class PeakSet {
      /**
       * @param channels - the channel count.
       * @param frames - the total frame count (known from the container header,
       *   which is what lets level 0 be allocated once).
       */
      constructor(channels, frames) {
        this.channels = channels
        this.frames = frames
        const buckets = Math.max(1, Math.ceil(frames / BASE_BUCKET))
        const level = { bucket: BASE_BUCKET, count: 0, mins: [], maxs: [], rmss: [] }
        for (let channel = 0; channel < channels; channel += 1) {
          level.mins.push(new Float32Array(buckets))
          level.maxs.push(new Float32Array(buckets))
          level.rmss.push(new Float32Array(buckets))
        }
        this.levels = [level]
        this.partial = []
        for (let channel = 0; channel < channels; channel += 1) this.partial.push({ min: Infinity, max: -Infinity, sumsq: 0 })
        this.partialFrames = 0
        this.fed = 0
      }

      /** Fold one decoded block into level 0. */
      push(channelData) {
        const frames = channelData.length > 0 ? channelData[0].length : 0
        if (frames === 0) return this
        let read = 0
        while (read < frames) {
          const take = Math.min(BASE_BUCKET - this.partialFrames, frames - read)
          for (let channel = 0; channel < this.channels; channel += 1) {
            const source = channelData[channel]
            const part = this.partial[channel]
            let min = part.min
            let max = part.max
            let sumsq = part.sumsq
            for (let index = 0; index < take; index += 1) {
              const value = source[read + index]
              if (value < min) min = value
              if (value > max) max = value
              sumsq += value * value
            }
            part.min = min
            part.max = max
            part.sumsq = sumsq
          }
          this.partialFrames += take
          read += take
          this.fed += take
          if (this.partialFrames === BASE_BUCKET) this.closeBucket(BASE_BUCKET)
        }
        return this
      }

      /** Write the bucket the partial accumulator has been filling. */
      closeBucket(divisor) {
        const level = this.levels[0]
        const index = level.count
        if (index >= level.mins[0].length) {
          this.partialFrames = 0
          return
        }
        for (let channel = 0; channel < this.channels; channel += 1) {
          const part = this.partial[channel]
          level.mins[channel][index] = part.min === Infinity ? 0 : part.min
          level.maxs[channel][index] = part.max === -Infinity ? 0 : part.max
          level.rmss[channel][index] = Math.sqrt(part.sumsq / divisor)
          part.min = Infinity
          part.max = -Infinity
          part.sumsq = 0
        }
        level.count = index + 1
        this.partialFrames = 0
      }

      /** Close the tail bucket and decimate the levels above. */
      finish() {
        if (this.partialFrames > 0) this.closeBucket(this.partialFrames)
        let previous = this.levels[0]
        while (previous.count > 2 && this.levels.length < MAX_LEVELS) {
          const next = decimateLevel(previous, this.channels)
          this.levels.push(next)
          previous = next
        }
        return this
      }
    }

    /** One level built from the level below, four buckets to one. */
    function decimateLevel(level, channels) {
      const count = Math.ceil(level.count / LEVEL_FACTOR)
      const next = { bucket: level.bucket * LEVEL_FACTOR, count: count, mins: [], maxs: [], rmss: [] }
      for (let channel = 0; channel < channels; channel += 1) {
        const mins = new Float32Array(count)
        const maxs = new Float32Array(count)
        const rmss = new Float32Array(count)
        for (let bucket = 0; bucket < count; bucket += 1) {
          const from = bucket * LEVEL_FACTOR
          const to = Math.min(level.count, from + LEVEL_FACTOR)
          let min = Infinity
          let max = -Infinity
          let sumsq = 0
          let seen = 0
          for (let index = from; index < to; index += 1) {
            if (level.mins[channel][index] < min) min = level.mins[channel][index]
            if (level.maxs[channel][index] > max) max = level.maxs[channel][index]
            sumsq += level.rmss[channel][index] * level.rmss[channel][index]
            seen += 1
          }
          mins[bucket] = seen === 0 ? 0 : min
          maxs[bucket] = seen === 0 ? 0 : max
          rmss[bucket] = seen === 0 ? 0 : Math.sqrt(sumsq / seen)
        }
        next.mins.push(mins)
        next.maxs.push(maxs)
        next.rmss.push(rmss)
      }
      return next
    }

    /** The level to read for a given samples-per-pixel: the largest one that fits. */
    function pickLevel(peaks, samplesPerPixel) {
      let chosen = peaks.levels[0]
      for (const level of peaks.levels) {
        if (level.bucket <= samplesPerPixel) chosen = level
      }
      return chosen
    }

    /** One pixel column's envelope, aggregated from the level's own buckets. */
    function columnEnvelope(level, channel, fromFrame, toFrame) {
      const bucket = level.bucket
      const first = Math.max(0, Math.floor(fromFrame / bucket))
      const last = Math.min(level.count, Math.ceil(toFrame / bucket))
      if (last <= first) return null
      let min = Infinity
      let max = -Infinity
      let sumsq = 0
      let seen = 0
      for (let index = first; index < last; index += 1) {
        if (level.mins[channel][index] < min) min = level.mins[channel][index]
        if (level.maxs[channel][index] > max) max = level.maxs[channel][index]
        sumsq += level.rmss[channel][index] * level.rmss[channel][index]
        seen += 1
      }
      return seen === 0 ? null : { min: min, max: max, rms: Math.sqrt(sumsq / seen) }
    }

    /** A peak pyramid over a decoded AudioBuffer (the FLAC path). */
    function peaksFromAudioBuffer(buffer) {
      const positions = []
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) positions.push(buffer.getChannelData(channel))
      const peaks = new PeakSet(buffer.numberOfChannels, buffer.length)
      const block = 65536
      for (let offset = 0; offset < buffer.length; offset += block) {
        const size = Math.min(block, buffer.length - offset)
        const slice = []
        for (let channel = 0; channel < positions.length; channel += 1) slice.push(positions[channel].subarray(offset, offset + size))
        peaks.push(slice)
      }
      return peaks.finish()
    }

    // =====================================================================
    // 6. Reading the file through the Remote
    // =====================================================================
    /**
     * Decode one base64 payload to native bytes.
     *
     * A plain indexed loop rather than `Uint8Array.from(atob(x), fn)`: calling
     * a mapper once per byte, for millions of bytes per window, is measurably
     * slower than the loop.
     */
    function decodeBase64(base64) {
      const binary = atob(String(base64))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /**
     * The bytes of one `readBytes` payload, in whichever shape the carrier
     * delivered them.
     *
     * The generated result codec declares `data` as `z.instanceof(Uint8Array)`
     * (the carrier decodes its binary frame into one, and the shipped preview
     * hands it straight to `new Blob`), but a window is read once per 2 MiB and
     * the whole substrate of this tab is those bytes, so the decode accepts the
     * other shapes a carrier could plausibly use rather than throwing
     * `InvalidCharacterError` out of `atob(String(uint8array))` - which is what
     * the base64-only decode did, and why a waveform could not be drawn from a
     * window the host had handed over correctly.
     *
     * @param data - the result's `data` field.
     * @returns the bytes, or null for a payload that is not bytes at all.
     */
    function bytesOf(data) {
      if (data instanceof Uint8Array) return data
      if (data instanceof ArrayBuffer) return new Uint8Array(data)
      if (Array.isArray(data)) return Uint8Array.from(data)
      if (typeof data === 'string' && data !== '') return decodeBase64(data)
      return null
    }

    /** The sentence a failed Remote call gets, from its own failure code. */
    function remoteErrorText(error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      if (code === 'workspace-file/too-large') return 'This file is larger than the harness lets one page read in a single call.'
      if (code === 'workspace-file/not-found') return 'There is no file at this path any more.'
      if (code === 'workspace-file/not-file') return 'This path is not a regular file.'
      if (code === 'workspace-file/outside-workspace') return 'This file is outside the conversation workspace.'
      if (code === 'workspace-file/unknown-workspace') return 'This tab names a conversation that is not open in this harness.'
      if (code === 'workspace-file/unsupported-address') return 'This tab does not name a readable workspace file.'
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return 'The file could not be read.'
    }

    /** What went wrong, as one sentence, whatever the thrown value is. */
    function thrownText(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    /** The harness refused the window as too large: learn its cap and shrink. */
    function refusedWindow(error, requested) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      if (code !== 'workspace-file/too-large' && code !== 'gateway/bad-request') return 0
      const limit = error && error.details && typeof error.details.limit === 'number' ? error.details.limit : 0
      if (limit > 0 && limit < requested) return limit
      return Math.floor(requested / 2)
    }

    /**
     * Read one byte window, adapting to the host's own per-window ceiling: a
     * deployment may configure it below this package's 2 MiB preference, and a
     * refusal names the limit rather than shortening the read, so the window is
     * halved (or clamped to the reported limit) and asked for again.
     * @returns `{ bytes, eof }`.
     */
    async function readWindow(sessionId, path, offset, length, signal) {
      let size = Math.max(1, Math.min(length, windowCap))
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await workspaceFiles.readBytes(sessionId, path, { offset: offset, length: size }, signal)
        if (result && result.ok === true) {
          const bytes = bytesOf(result.value.data)
          if (bytes === null) throw new Error('The host handed over a window of this file in a shape this tab cannot read.')
          windowCap = Math.max(WINDOW_FLOOR, size)
          return { bytes: bytes, eof: result.value.eof === true }
        }
        const error = result ? result.error : null
        const smaller = refusedWindow(error, size)
        if (smaller > 0 && smaller < size && size > WINDOW_FLOOR) {
          size = Math.max(WINDOW_FLOOR, smaller)
          continue
        }
        throw new Error(remoteErrorText(error))
      }
      throw new Error('This harness would not hand over even a small window of the file.')
    }

    /**
     * Read the whole file through the Remote (the FLAC path).
     *
     * `readBytes` with EMPTY options is the namespace's whole-file read - the
     * generated Remote has no `readAll` at all, and asking for one threw the
     * "no workspaceFiles remote" sentence at every FLAC. The payload must also
     * reach EOF: a file past the host's single-read ceiling arrives TRUNCATED
     * with `eof: false`, and a browser decoder handed a truncated FLAC would
     * report a decode fault instead of the size that caused it.
     * @returns the file's bytes.
     */
    async function readWhole(sessionId, path, signal) {
      const result = await workspaceFiles.readBytes(sessionId, path, {}, signal)
      if (!result || result.ok !== true) throw new Error(remoteErrorText(result ? result.error : null))
      if (result.value && result.value.eof === false) {
        throw new Error('This file is larger than this harness will hand over in one read, so it cannot be decoded.')
      }
      const bytes = bytesOf(result.value ? result.value.data : null)
      if (bytes === null) throw new Error('The host returned no bytes for this file.')
      return bytes
    }

    /** The file's size, or 0 when the host will not say. */
    async function readSize(sessionId, path, signal) {
      const result = await workspaceFiles.stat(sessionId, path, signal)
      if (result && result.ok === true && result.value && typeof result.value.bytes === 'number') return result.value.bytes
      if (result && result.ok !== true) throw new Error(remoteErrorText(result.error))
      return 0
    }

    // =====================================================================
    // 7. The loader: facts, peaks, and (when the file is small enough) samples
    // =====================================================================

    /** Join a carried tail with the next window. */
    function concatBytes(first, second) {
      if (first.length === 0) return second
      const joined = new Uint8Array(first.length + second.length)
      joined.set(first, 0)
      joined.set(second, first.length)
      return joined
    }

    /**
     * Read a prefix of the file, joining as many windows as it takes.
     *
     * The host hands over one window per call, so a prefix larger than that
     * window is several calls stitched - which is what the header probe needs
     * when a chunk walk runs past a window boundary. The host's own `eof` is
     * carried out with the bytes: that flag ("does this window reach the last
     * byte") is what lets a parser that stopped early answer with a verdict
     * instead of asking for more.
     * @returns `{ bytes, eof }`.
     */
    async function readPrefix(sessionId, path, length, signal) {
      const parts = []
      let read = 0
      let eof = false
      while (read < length) {
        const want = length - read
        const window = await readWindow(sessionId, path, read, want, signal)
        eof = window.eof === true
        if (window.bytes.length === 0) break
        parts.push(window.bytes)
        read += window.bytes.length
        if (window.bytes.length < Math.min(want, windowCap)) break
      }
      if (parts.length === 0) return { bytes: new Uint8Array(0), eof: eof }
      if (parts.length === 1) return { bytes: parts[0], eof: eof }
      let total = 0
      for (const part of parts) total += part.length
      const joined = new Uint8Array(total)
      let at = 0
      for (const part of parts) {
        joined.set(part, at)
        at += part.length
      }
      return { bytes: joined, eof: eof }
    }

    /**
     * Read just enough of the file's head to know WHAT it is: 64 KiB first, then
     * four times as much at a time up to an 8 MiB ceiling, stopping the moment a
     * container parses.
     * @returns the container's facts, `{ ok: false, reason }` included.
     */
    async function probeFile(sessionId, path, size, signal) {
      const ceiling = size > 0 ? Math.min(size, PROBE_CEILING) : PROBE_CEILING
      let length = Math.max(1, Math.min(ceiling, PROBE_START))
      let facts = null
      for (let step = 0; step < 8; step += 1) {
        const prefix = await readPrefix(sessionId, path, length, signal)
        const bytes = prefix.bytes
        // Whether these bytes are the WHOLE file is what a parser's "read more"
        // has to be judged against: a prefix that already holds the file's last
        // byte can be answered with the parser's own verdict, and the caller then
        // never blames the 8 MiB ceiling for a file it has read to the end.
        const wholeFile = prefix.eof === true || (size > 0 && bytes.length >= size)
        facts = parseContainer(bytes, size > 0 ? size : bytes.length, wholeFile)
        if (facts.ok === true) return facts
        if (facts.needsMore !== true) return facts
        if (wholeFile) return facts
        if (length >= ceiling) return facts
        length = Math.min(ceiling, length * PROBE_GROWTH)
      }
      return facts
    }

    /**
     * A WAV/AIFF file, decoded by this package, window by window.
     *
     * The samples are folded into the peak pyramid and DROPPED, so a file far
     * past the single-read cap still draws; they are kept as well only when the
     * whole decode fits the playback budget, because that is what a seek and a
     * playhead need.
     *
     * @param facts - the container's parsed facts (the header probe's answer).
     * @returns `{ facts, peaks, samples, source }`.
     */
    async function loadPcmFile(sessionId, path, size, facts, signal, onProgress) {
      const format = facts.format
      if (!(facts.frames > 0)) {
        throw new Error(
          'this ' + facts.container + ' declares no audio frames, so there is no waveform in it (the header parses and the samples are simply not there)',
        )
      }
      const peaks = new PeakSet(format.channels, facts.frames)
      const holdSamples =
        facts.frames > 0 &&
        size > 0 &&
        size <= PLAYBACK_BYTES &&
        facts.frames * format.channels <= PLAYBACK_SAMPLES
      const samples = holdSamples ? [] : null
      if (samples !== null) {
        for (let channel = 0; channel < format.channels; channel += 1) samples.push(new Float32Array(facts.frames))
      }
      let offset = facts.dataOffset
      const end = facts.dataOffset + facts.dataBytes
      let filled = 0
      let carried = new Uint8Array(0)
      let lastReport = -1
      while (offset < end) {
        if (signal.aborted) throw new Error('cancelled')
        const length = Math.min(windowCap, end - offset)
        const window = await readWindow(sessionId, path, offset, length, signal)
        let bytes = concatBytes(carried, window.bytes)
        const usable = bytes.length - (bytes.length % format.blockAlign)
        carried = usable < bytes.length ? bytes.slice(usable) : new Uint8Array(0)
        if (usable > 0) {
          const decoded = decodePcm(format, bytes.subarray(0, usable))
          peaks.push(decoded.channels)
          if (samples !== null) {
            for (let channel = 0; channel < format.channels; channel += 1) {
              const take = Math.min(decoded.frames, facts.frames - filled)
              if (take > 0) samples[channel].set(decoded.channels[channel].subarray(0, take), filled)
            }
          }
          filled += decoded.frames
        }
        offset += window.bytes.length
        if (window.bytes.length === 0) break
        const percent = facts.dataBytes > 0 ? Math.floor(((offset - facts.dataOffset) / facts.dataBytes) * 100) : 100
        if (onProgress !== undefined && percent !== lastReport) {
          lastReport = percent
          onProgress(percent)
        }
      }
      peaks.finish()
      return {
        facts: facts,
        peaks: peaks,
        samples: samples,
        source: 'this package (WAV/AIFF decoded in the page, window by window)',
      }
    }

    /**
     * A FLAC file, decoded by the BROWSER's own decoder.
     *
     * `decodeAudioData` takes a whole file, so this path is the one bounded by
     * the harness's single-read cap. When that cap refuses the file its facts
     * are still read from STREAMINFO - which is the honest half of the answer.
     *
     * @param probed - the facts from the header probe.
     * @returns `{ facts, peaks, buffer, source }` or `{ facts, peaks: null, refusal }`.
     */
    async function loadFlacFile(sessionId, path, size, probed, signal, onProgress) {
      let bytes = null
      try {
        bytes = await readWhole(sessionId, path, signal)
      } catch (err) {
        return {
          facts: probed,
          peaks: null,
          buffer: null,
          source: 'the browser (FLAC)',
          refusal:
            'This FLAC is ' +
            humanBytes(size) +
            ', and drawing its waveform means handing the whole file to the browser in one read, which the harness caps at 32 MiB by default (' +
            thrownText(err) +
            '). The facts shown are read from the file itself, so they are exact.',
        }
      }
      const parsed = parseFlacInfo(bytes)
      const facts = parsed.ok === true ? parsed : probed
      if (onProgress !== undefined) onProgress(20)
      const buffer = await decodeWithBrowser(bytes, facts.sampleRate)
      if (onProgress !== undefined) onProgress(70)
      const peaks = peaksFromAudioBuffer(buffer)
      if (onProgress !== undefined) onProgress(100)
      return {
        facts: {
          ...facts,
          frames: buffer.length,
          duration: buffer.duration > 0 ? buffer.duration : facts.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          resampled: buffer.sampleRate !== facts.sampleRate,
        },
        peaks: peaks,
        buffer: buffer,
        samples: null,
        source: 'the browser (FLAC)',
      }
    }

    /**
     * The AudioContext, created on first use (a `suspended` one decodes fine).
     *
     * ONE context for the whole package, which is what makes the audio console's
     * output pick apply to the waveform player's playback as well as to its own
     * test tone: `AudioContext.setSinkId` moves this graph, and section 13 is the
     * only code that ever calls it on it. A context created AFTER the person
     * chose an output is pointed at it here, at the one moment it exists and the
     * console may not be on screen.
     */
    let audioContext = null
    function audioContextNow() {
      if (audioContext === null) {
        const Ctor = window.AudioContext === undefined ? window.webkitAudioContext : window.AudioContext
        if (Ctor === undefined) throw new Error('this browser exposes no Web Audio implementation')
        audioContext = new Ctor()
        applyChosenSink(audioContext)
      }
      return audioContext
    }

    /**
     * Decode a FLAC with the browser.
     *
     * An OfflineAudioContext at the FILE's own sample rate is preferred, since
     * `decodeAudioData` resamples to its context's rate - a 44.1 kHz file
     * decoded into a 48 kHz context would come back resampled. The file states
     * its rate in STREAMINFO before any decoding, so the context can be built at
     * that rate; a rate outside what the browser accepts falls back to the live
     * context and the facts panel says "resampled".
     */
    async function decodeWithBrowser(bytes, sampleRate) {
      // `decodeAudioData` DETACHES the ArrayBuffer it is handed, so it is given
      // a copy this package owns rather than the window's own buffer.
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      const Offline = window.OfflineAudioContext === undefined ? window.webkitOfflineAudioContext : window.OfflineAudioContext
      let context = null
      if (Offline !== undefined && sampleRate >= 8000 && sampleRate <= 96000) {
        try {
          context = new Offline(1, 1, sampleRate)
        } catch (err) {
          context = null
        }
      }
      if (context === null) context = audioContextNow()
      const decoded = context.decodeAudioData(copy.buffer)
      return decoded && typeof decoded.then === 'function' ? await decoded : decoded
    }

    // =====================================================================
    // 8. Formatting
    // =====================================================================
    /** `m:ss.mmm`, with the hours only when there are any. */
    function formatTime(seconds, decimals) {
      const places = decimals === undefined ? 3 : decimals
      const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
      const hours = Math.floor(value / 3600)
      const minutes = Math.floor((value % 3600) / 60)
      const rest = value % 60
      const text = (rest < 10 ? '0' : '') + rest.toFixed(places)
      if (hours > 0) return hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + text
      return minutes + ':' + text
    }

    /** dBFS for one amplitude, or null when it is silence. */
    function amplitudeToDb(value) {
      const magnitude = Math.abs(value)
      if (!(magnitude > 0)) return null
      return 20 * Math.log10(magnitude)
    }

    /** `-6.2 dBFS`, or the word for actual silence. */
    function formatDb(value) {
      const db = amplitudeToDb(value)
      if (db === null) return 'silent'
      if (db <= -100) return '-inf dBFS'
      return db.toFixed(1) + ' dBFS'
    }

    /** A byte count a person reads at a glance. */
    function humanBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KiB'
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1) + ' MiB'
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB'
    }

    /**
     * The track's name in the gutter: L/R for a stereo pair, the track's number
     * past that, and NOTHING for a mono file - a lone "M" is a letter the reader
     * has to decode, and one track has nothing to tell apart from.
     */
    function channelLabel(index, channels) {
      if (channels <= 1) return ''
      if (channels === 2) return index === 0 ? 'L' : 'R'
      return String(index + 1)
    }

    /**
     * The "nice" 1-2-5 step for a ruler, in seconds, chosen so labels stay at
     * least `minPixels` apart at this zoom.
     */
    const TICK_STEPS = [
      0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
      900, 1800, 3600,
    ]
    function tickStepFor(pxPerSecond, minPixels) {
      const wanted = minPixels / Math.max(1e-9, pxPerSecond)
      for (const step of TICK_STEPS) {
        if (step >= wanted) return step
      }
      return TICK_STEPS[TICK_STEPS.length - 1]
    }

    /** How many decimals a ruler label needs for one step. */
    function tickDecimals(step) {
      if (step < 0.001) return 4
      if (step < 0.01) return 3
      if (step < 0.1) return 2
      if (step < 1) return 2
      if (step < 60) return 0
      return 0
    }

    // =====================================================================
    // 9. Addresses (the same grammar dsh-image and dsh-pdf use)
    // =====================================================================
    /** Component-decode one path segment of the file grammar, tolerating a bad one. */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch (err) {
        return segment
      }
    }

    /**
     * Read the one address shape this type claims.
     * @returns `{ sessionId, path }`, or null when the address is not a
     *   session-scoped file address.
     */
    function parseAudioAddress(address) {
      const value = typeof address === 'string' ? address : ''
      if (value.slice(0, FILE_PREFIX.length) !== FILE_PREFIX) return null
      const rest = value.slice(FILE_PREFIX.length)
      if (rest.slice(0, SESSION_SEGMENT.length) !== SESSION_SEGMENT) return null
      const tail = rest.slice(SESSION_SEGMENT.length)
      const cut = tail.indexOf('/')
      if (cut < 0) return null
      const path = tail
        .slice(cut + 1)
        .split('/')
        .map(decodeSegment)
        .join('/')
      if (path === '') return null
      return { sessionId: decodeSegment(tail.slice(0, cut)), path: path }
    }

    /** The lower-cased extension of a path (`''` for none and for dotfiles). */
    function extensionOf(path) {
      const normalized = String(path).replace(/\\/g, '/')
      const name = normalized.slice(normalized.lastIndexOf('/') + 1)
      const dot = name.lastIndexOf('.')
      return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
    }

    /** The media type an address's suffix maps to, or `''` for an unclaimed one. */
    function mediaTypeFor(path) {
      const extension = extensionOf(path)
      return MEDIA_TYPES[extension] === undefined ? '' : MEDIA_TYPES[extension]
    }

    /** Whether an address names an audio file this type claims. */
    function isAudioAddress(address) {
      const parsed = parseAudioAddress(address)
      return parsed !== null && mediaTypeFor(parsed.path) !== ''
    }

    /** The decoded last path segment of an address, for the chip title. */
    function baseNameOf(address) {
      const parsed = parseAudioAddress(address)
      if (!parsed) return 'Audio'
      const name = parsed.path.replace(/\\/g, '/').split('/').pop()
      return name === '' || name === undefined ? 'Audio' : name
    }

    // =====================================================================
    // 10. Small React helpers
    // =====================================================================
    /** The tab information a pane body was handed, or null when it has none. */
    function tabInfoNow(props) {
      if (!props || typeof props.useTabInfo !== 'function') return null
      try {
        const info = props.useTabInfo()
        return info && info.tab ? info : null
      } catch (err) {
        return null
      }
    }

    /** One 16px stroked glyph. */
    function Glyph(props) {
      const size = props.size === undefined ? 14 : props.size
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        ...props.paths.map((path) => h('path', { key: path, d: path })),
      )
    }

    const ICONS = {
      play: ['M5 3.2v9.6l8-4.8z'],
      pause: ['M5.4 3.2v9.6', 'M10.6 3.2v9.6'],
      zoomIn: ['M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Z', 'M10.3 10.3 14 14', 'M5 7h4', 'M7 5v4'],
      zoomOut: ['M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Z', 'M10.3 10.3 14 14', 'M5 7h4'],
      fit: ['M2.6 6V2.6H6', 'M10 2.6h3.4V6', 'M13.4 10v3.4H10', 'M6 13.4H2.6V10'],
      reload: ['M13.3 8a5.3 5.3 0 1 1-1.6-3.8', 'M13.3 2.4v3h-3'],
      clear: ['M4 4l8 8', 'M12 4l-8 8'],
      info: ['M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6Z', 'M8 7.4v3.4', 'M8 5.2v.6'],
    }

    /** One centred state: loading, a failure, or a refused address. */
    function StateBox(props) {
      return h(
        'div',
        { className: 'dsa-state', 'data-audio-state': props.state },
        h('div', { className: 'dsa-stateTitle' }, props.title),
        props.error ? h('div', { className: 'dsa-stateErr' }, props.error) : null,
        props.note ? h('div', { className: 'dsa-stateNote' }, props.note) : null,
        props.children ? h('div', { className: 'dsa-row' }, props.children) : null,
      )
    }

    /** The details panel: what the host and the decoder actually reported. */
    function InfoPanel(props) {
      const facts = props.facts
      const metadata = facts.metadata || {}
      const rows = [
        ['container', facts.container],
        ['codec', facts.codec],
        ['sample rate', facts.sampleRate + ' Hz'],
        ['channels', String(facts.channels)],
        ['bit depth', facts.bits > 0 ? facts.bits + '-bit' : 'not stated'],
        ['frames', facts.frames.toLocaleString ? facts.frames.toLocaleString('en-US') : String(facts.frames)],
        ['duration', formatTime(facts.duration)],
        ['size', humanBytes(props.size) === '' ? 'unknown' : humanBytes(props.size)],
        ['decoded by', props.source],
        ['peak pyramid', props.levels],
      ]
      if (facts.resampled) rows.push(['note', 'the browser resampled this file to its own device rate'])
      if (facts.truncated) rows.push(['truncated', 'the file ends before the length its header declares, so the tail is UNKNOWN, not silence'])
      if (metadata.title) rows.push(['title', metadata.title])
      if (metadata.artist) rows.push(['artist', metadata.artist])
      if (metadata.album) rows.push(['album', metadata.album])
      if (metadata.date) rows.push(['date', metadata.date])
      if (metadata.genre) rows.push(['genre', metadata.genre])
      if (metadata.comment) rows.push(['comment', metadata.comment])
      if (metadata.software) rows.push(['software', metadata.software])
      if (metadata.broadcast) {
        const broadcast = metadata.broadcast
        if (broadcast.description) rows.push(['BWF description', broadcast.description])
        if (broadcast.originator) rows.push(['BWF originator', broadcast.originator])
        if (broadcast.originationDate) rows.push(['BWF date', broadcast.originationDate + ' ' + broadcast.originationTime])
      }
      return h(
        'div',
        { className: 'dsa-info', 'data-audio-info': 'true' },
        ...rows.map((row) => h('div', { className: 'dsa-infoRow', key: row[0] }, h('span', { className: 'dsa-infoKey' }, row[0]), h('span', { className: 'dsa-infoVal' }, row[1]))),
      )
    }

    // =====================================================================
    // 11. Reading and decoding one file
    // =====================================================================
    /**
     * Load one audio file: facts, a peak pyramid, and samples when the file is
     * small enough to hold.
     *
     * @returns `{ phase, facts, peaks, samples, buffer, source, refusal, progress, error }`.
     */
    function useAudioSource(address, fallbackSession, reload) {
      const [state, setState] = useState({ phase: 'loading', progress: 0, stage: 'opening' })
      useEffect(() => {
        const parsed = parseAudioAddress(address)
        if (!parsed) {
          setState({ phase: 'failed', error: 'This tab does not name a workspace file.' })
          return undefined
        }
        if (mediaTypeFor(parsed.path) === '') {
          setState({ phase: 'failed', error: 'This audio format is not one the viewer claims.' })
          return undefined
        }
        if (workspaceFiles === null || typeof workspaceFiles.readBytes !== 'function') {
          setState({ phase: 'failed', error: 'This harness exposes no workspaceFiles remote, so the file cannot be read.' })
          return undefined
        }
        const sessionId = parsed.sessionId === '' ? fallbackSession : parsed.sessionId
        const controller = new AbortController()
        let live = true
        const settle = (next) => {
          if (live) setState(next)
        }
        const onProgress = (percent) => {
          if (live) setState((previous) => (previous.phase === 'loading' ? { phase: 'loading', progress: percent, stage: 'decoding' } : previous))
        }
        setState({ phase: 'loading', progress: 0, stage: 'opening' })
        const run = async () => {
          const size = await readSize(sessionId, parsed.path, controller.signal)
          settle({ phase: 'loading', progress: 0, stage: 'reading the header' })
          // WHAT the file is decides who decodes it, not what it is called: a
          // FLAC named `.wav` still takes the browser's decoder and a WAV named
          // `.flac` still takes this package's.
          const facts = await probeFile(sessionId, parsed.path, size, controller.signal)
          if (facts === null || facts.ok !== true) {
            throw new Error(
              facts && facts.needsMore === true
                ? "this file's header is larger than the 8 MiB this viewer reads looking for the audio, so its format was never reached"
                : facts && facts.reason
                  ? facts.reason
                  : 'this file could not be read as audio',
            )
          }
          const loaded =
            facts.format.compressed === true
              ? await loadFlacFile(sessionId, parsed.path, size, facts, controller.signal, onProgress)
              : await loadPcmFile(sessionId, parsed.path, size, facts, controller.signal, onProgress)
          if (!live) return
          settle({ phase: 'ready', size: size, ...loaded })
        }
        run().catch((error) => {
          if (!live) return
          if (controller.signal.aborted) return
          settle({ phase: 'failed', error: thrownText(error) })
        })
        return () => {
          live = false
          controller.abort()
        }
      }, [address, fallbackSession, reload])
      return state
    }

    // =====================================================================
    // 12. The waveform canvas
    // =====================================================================
    /**
     * The palette the canvas paints with when the app's own tokens cannot be
     * read (no `getComputedStyle`, an unmounted canvas, a token the theme does
     * not define). Chosen to read on a light AND a dark page.
     */
    /**
     * ONE accent, and the alphas of the surfaces that sit ON the waveform.
     *
     * The alpha is what separates them: the envelope is the accent at 55%, the
     * RMS core inside it is the accent solid, the selection wash is 16% and its
     * edge 50%. Both paths below derive all four from that one accent, so a token
     * the theme cannot hand over changes the SHADE and nothing else - which is
     * the bug this shape exists to prevent. The token path used to read a name
     * the pinned line does not define and hand the same opaque colour to every
     * one of the four, so the RMS core was painted in its envelope's own colour
     * (invisible), the stems were solid and the selection covered the waveform.
     */
    const ACCENT_FALLBACK = '#4f8cff'
    const ENVELOPE_ALPHA = 0.55
    const RMS_ALPHA = 1
    const SELECTION_ALPHA = 0.16
    const SELECTION_EDGE_ALPHA = 0.5

    /**
     * Whether a canvas takes this colour, asked ONCE and remembered.
     *
     * It has to be asked rather than assumed: a canvas ignores a `fillStyle` it
     * cannot parse and KEEPS THE PREVIOUS ONE, so an unparsed colour paints the
     * wrong thing (the hairline, the track wash) rather than a wrong shade.
     */
    let canvasTakesCache = null
    function canvasTakes(colour) {
      if (canvasTakesCache !== null) return canvasTakesCache
      canvasTakesCache = false
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
        if (!context) return false
        context.fillStyle = '#010203'
        context.fillStyle = colour
        canvasTakesCache = context.fillStyle !== '#010203'
      } catch (err) {
        canvasTakesCache = false
      }
      return canvasTakesCache
    }

    /**
     * A colour with an alpha applied to it.
     *
     * The theme's accent token is OPAQUE, so every surface that is meant to sit
     * over the waveform needs its alpha put on here. A hex token (the shape the
     * harness's colours take) is parsed directly; anything else goes through CSS
     * `color-mix`, which is tested first because the substitute for an unparsed
     * canvas colour is a wrong colour, not a weaker one. A browser with neither
     * gets the solid accent, which is still visible - only its alpha is lost.
     */
    function withAlpha(colour, alpha) {
      const text = String(colour).trim()
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
      if (hex) {
        const digits = hex[1]
        const full =
          digits.length === 3
            ? digits.charAt(0) + digits.charAt(0) + digits.charAt(1) + digits.charAt(1) + digits.charAt(2) + digits.charAt(2)
            : digits
        return (
          'rgba(' +
          parseInt(full.slice(0, 2), 16) +
          ',' +
          parseInt(full.slice(2, 4), 16) +
          ',' +
          parseInt(full.slice(4, 6), 16) +
          ',' +
          alpha +
          ')'
        )
      }
      const mixed = 'color-mix(in srgb, ' + text + ' ' + Math.round(alpha * 100) + '%, transparent)'
      return canvasTakes(mixed) ? mixed : text
    }

    /** The palette of last resort: the same accent, the same alphas. */
    const FALLBACK_PALETTE = {
      track: 'rgba(127,127,127,.05)',
      hairline: 'rgba(127,127,127,.22)',
      text: '#8a8a8a',
      textStrong: '#5a5a5a',
      envelope: withAlpha(ACCENT_FALLBACK, ENVELOPE_ALPHA),
      rms: withAlpha(ACCENT_FALLBACK, RMS_ALPHA),
      playhead: '#e5484d',
      selection: withAlpha(ACCENT_FALLBACK, SELECTION_ALPHA),
      selectionEdge: withAlpha(ACCENT_FALLBACK, SELECTION_EDGE_ALPHA),
    }

    /** The palette the canvas paints with, read off the app's own tokens. */
    function canvasPalette(element) {
      const fallback = FALLBACK_PALETTE
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function' || !element) return fallback
      try {
        const styles = window.getComputedStyle(element)
        const value = (name, otherwise) => {
          const raw = styles.getPropertyValue(name)
          return raw === undefined || raw.trim() === '' ? otherwise : raw.trim()
        }
        const accent = value('--dsw-alias-brand-primary', ACCENT_FALLBACK)
        return {
          track: value('--dsw-alias-bg-layer-1', fallback.track),
          hairline: value('--dsw-alias-border-l3', fallback.hairline),
          text: value('--dsw-alias-label-tertiary', fallback.text),
          textStrong: value('--dsw-alias-label-secondary', fallback.textStrong),
          envelope: withAlpha(accent, ENVELOPE_ALPHA),
          rms: withAlpha(accent, RMS_ALPHA),
          playhead: value('--dsw-alias-state-error-primary', fallback.playhead),
          selection: withAlpha(accent, SELECTION_ALPHA),
          selectionEdge: withAlpha(accent, SELECTION_EDGE_ALPHA),
        }
      } catch (err) {
        return fallback
      }
    }

    /**
     * The waveform viewer.
     *
     * One rule shapes the whole component: the ZOOM IS A LAYOUT WIDTH. The
     * scrollable spacer is the file's duration times the pixels-per-second, so
     * panning is the pane's own `scrollLeft` and everything the browser already
     * does keeps working; the canvas that paints the waveform is VIEWPORT-SIZED
     * and sticky at the pane's left edge, because a canvas cannot be hundreds of
     * thousands of pixels wide. A zoom therefore changes the spacer's width and
     * repaints the window onto it - never a CSS transform, which would scale
     * into a clipped box with no scrollable area.
     */
    function AudioViewer(props) {
      const { facts, peaks, samples, buffer, size, source, name, path, onReload } = props
      const scrollRef = useRef(null)
      const canvasRef = useRef(null)
      const drawRef = useRef(null)
      const wheelHandler = useRef(null)
      const dragRef = useRef(null)
      const playRef = useRef(null)
      /**
       * The zoom the LAYOUT is actually at, written synchronously by every move.
       * A trackpad pinch arrives as a STREAM of wheel events that can all land
       * before React re-renders, so a handler reading the `pxPerSecond` state
       * would compute every step from the same base and the gesture would
       * under-zoom badly. The wheel and ladder handlers read this instead.
       */
      const ppsRef = useRef(MIN_PPS)
      const [pxPerSecond, setPxPerSecond] = useState(MIN_PPS)
      const [fit, setFit] = useState(true)
      const [dbMode, setDbMode] = useState(false)
      const [gain, setGain] = useState(1)
      const [shownTracks, setShownTracks] = useState(facts.channels)
      const [trackHeight, setTrackHeight] = useState(TRACK_H)
      const [selection, setSelection] = useState(null)
      const [pointer, setPointer] = useState(null)
      const [playhead, setPlayhead] = useState(0)
      const [playing, setPlaying] = useState(false)
      const [showInfo, setShowInfo] = useState(false)
      const [themeTick, setThemeTick] = useState(0)

      const duration = facts.duration > 0 ? facts.duration : 0
      const channels = facts.channels
      /** How many TRACKS are drawn: one row per channel, all of them by default. */
      const trackRows = Math.max(1, Math.min(shownTracks, channels))
      const trackStride = trackHeight + TRACK_GAP
      const contentHeight = RULER_H + trackRows * trackStride
      /**
       * The zoom's own ceiling is the FILE's: a browser will not lay out an
       * element wider than ~33.5 M px, so the top rung is whatever keeps the
       * whole file inside that, and "individual samples" is what it leaves for
       * a short file.
       */
      const maxPps = Math.max(MIN_PPS, Math.min(MAX_PPS, duration > 0 ? MAX_CONTENT_PX / duration : MAX_PPS))
      const totalPx = Math.max(1, Math.round(duration * pxPerSecond))
      const contentWidth = GUTTER + totalPx

      const paletteRef = useRef(FALLBACK_PALETTE)
      const palette = paletteRef.current
      const canPlay = buffer !== null && buffer !== undefined ? true : samples !== null && samples !== undefined

      /**
       * The palette is read AFTER mount: at the first render the canvas does not
       * exist yet, so a `useMemo` over a null ref would freeze the fallback
       * colours for the tab's whole life.
       */
      useEffect(() => {
        paletteRef.current = canvasPalette(canvasRef.current)
        if (drawRef.current) drawRef.current()
      }, [themeTick])

      // The app's own theme switch (and this package's palettes) repaint.
      useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
        const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1))
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
        return () => observer.disconnect()
      }, [])

      /** The visible width of the pane, which is the canvas's own width. */
      const paneWidth = useCallback(() => {
        const scroller = scrollRef.current
        return scroller ? Math.max(80, scroller.clientWidth) : 600
      }, [])

      /** Pixels per second that shows the whole file in the pane. */
      const fitPps = useCallback(() => {
        const width = paneWidth() - GUTTER - FIT_PADDING * 2
        if (!(duration > 0)) return MIN_PPS
        return Math.min(maxPps, Math.max(MIN_PPS, width / duration))
      }, [duration, maxPps, paneWidth])

      /**
       * Paint the window of the file the pane is looking at.
       *
       * Everything here reads refs and the current props rather than relying on
       * a render, because this runs on every scroll frame.
       */
      const draw = useCallback(() => {
        const canvas = canvasRef.current
        const scroller = scrollRef.current
        if (!canvas || !scroller) return
        const context = canvas.getContext('2d')
        if (!context) return
        const cssWidth = Math.max(80, scroller.clientWidth)
        const cssHeight = contentHeight
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
        if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
          canvas.width = Math.max(1, Math.round(cssWidth * dpr))
          canvas.height = Math.max(1, Math.round(cssHeight * dpr))
        }
        if (canvas.style.width !== cssWidth + 'px') canvas.style.width = cssWidth + 'px'
        if (canvas.style.height !== cssHeight + 'px') canvas.style.height = cssHeight + 'px'
        const scrollLeft = scroller.scrollLeft
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        context.clearRect(0, 0, cssWidth, cssHeight)
        // The track beds, so an empty stretch reads as a track and not as a
        // hole. Every track is a ROW of its own, all the way across: a file
        // with eight channels shows eight rows, not eight overlays.
        context.fillStyle = palette.track
        for (let track = 0; track < trackRows; track += 1) {
          context.fillRect(GUTTER, RULER_H + track * trackStride, cssWidth - GUTTER, trackHeight)
        }
        context.fillStyle = palette.track
        context.fillRect(0, 0, cssWidth, RULER_H)

        const samplesPerPixel = pxPerSecond > 0 ? facts.sampleRate / pxPerSecond : 1
        const level = pickLevel(peaks, samplesPerPixel)
        const pxPerSample = pxPerSecond / Math.max(1, facts.sampleRate)
        const stems = samples !== null && samples !== undefined && pxPerSample >= STEM_PX_PER_SAMPLE

        /** The top of one track's row. */
        const trackTop = (track) => RULER_H + track * trackStride
        /** Content x for a time, and back. */
        const xOf = (time) => GUTTER + time * pxPerSecond
        const timeOf = (canvasX) => (canvasX + scrollLeft - GUTTER) / pxPerSecond

        // The selection, under the waveform.
        if (selection !== null) {
          const from = Math.min(selection.from, selection.to)
          const to = Math.max(selection.from, selection.to)
          const left = Math.max(GUTTER, xOf(from) - scrollLeft)
          const right = Math.min(cssWidth, xOf(to) - scrollLeft)
          if (right > left) {
            context.save()
            context.globalAlpha = 0.16
            context.fillStyle = palette.selection
            context.fillRect(left, RULER_H, right - left, cssHeight - RULER_H)
            context.restore()
            context.fillStyle = palette.selectionEdge
            context.globalAlpha = 0.5
            context.fillRect(left, RULER_H, 1, cssHeight - RULER_H)
            context.fillRect(right - 1, RULER_H, 1, cssHeight - RULER_H)
            context.globalAlpha = 1
          }
        }

        // The waveform, column by column. A device column is one CSS pixel at
        // dpr 1 and half of one at dpr 2, so the envelope is as fine as the
        // screen rather than as fine as the CSS layout.
        const columnStep = 1 / dpr
        for (let track = 0; track < trackRows; track += 1) {
          const top = trackTop(track)
          const centre = top + trackHeight / 2
          const halfHeight = (trackHeight / 2) * 0.94
          // Zero line.
          context.fillStyle = palette.hairline
          context.fillRect(GUTTER, Math.round(centre), cssWidth - GUTTER, 1)
          if (stems) {
            // Few enough samples on screen to draw them individually: a stem
            // per sample and a line through the peaks, which is what a sample
            // view is for.
            const fromTime = Math.max(0, timeOf(GUTTER))
            const toTime = Math.min(duration, timeOf(cssWidth))
            const firstFrame = Math.max(0, Math.floor(fromTime * facts.sampleRate))
            const lastFrame = Math.min(samples[track].length - 1, Math.ceil(toTime * facts.sampleRate))
            const amplitudeY = (value) => {
              const scaled = Math.max(-1, Math.min(1, value * gain))
              return centre - (dbMode ? Math.sign(scaled) * Math.min(1, dbMagnitude(scaled)) : scaled) * halfHeight
            }
            context.strokeStyle = palette.envelope
            context.lineWidth = 1
            context.beginPath()
            for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
              const x = xOf(frame / facts.sampleRate) - scrollLeft
              if (x < GUTTER - 1) continue
              if (x > cssWidth + 1) break
              const value = samples[track][frame]
              const y = amplitudeY(value)
              context.moveTo(Math.round(x) + 0.5, centre)
              context.lineTo(Math.round(x) + 0.5, y)
            }
            context.stroke()
            context.beginPath()
            for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
              const x = xOf(frame / facts.sampleRate) - scrollLeft
              if (x < GUTTER - 1) continue
              if (x > cssWidth + 1) break
              const y = amplitudeY(samples[track][frame])
              if (frame === firstFrame) context.moveTo(x, y)
              else context.lineTo(x, y)
            }
            context.stroke()
            continue
          }
          for (let x = GUTTER; x < cssWidth; x += columnStep) {
            const fromFrame = Math.max(0, timeOf(x) * facts.sampleRate)
            const toFrame = Math.max(fromFrame + 1e-6, timeOf(x + columnStep) * facts.sampleRate)
            const envelope = columnEnvelope(level, Math.min(track, level.mins.length - 1), fromFrame, toFrame)
            if (envelope === null) continue
            const topY = amplitudeToY(envelope.max, centre, halfHeight, dbMode, gain)
            const bottomY = amplitudeToY(envelope.min, centre, halfHeight, dbMode, gain)
            context.fillStyle = palette.envelope
            context.fillRect(x, Math.min(topY, bottomY), columnStep, Math.max(1, Math.abs(bottomY - topY)))
            const rmsTop = amplitudeToY(envelope.rms, centre, halfHeight, dbMode, gain)
            const rmsBottom = amplitudeToY(-envelope.rms, centre, halfHeight, dbMode, gain)
            context.fillStyle = palette.rms
            context.fillRect(x, Math.min(rmsTop, rmsBottom), columnStep, Math.max(1, Math.abs(rmsBottom - rmsTop)))
          }
        }

        // The time ruler: 1-2-5 steps, labels MEASURED so they never collide.
        const step = tickStepFor(pxPerSecond, 64)
        const decimals = tickDecimals(step)
        const first = Math.max(0, Math.floor(timeOf(GUTTER) / step) * step)
        const last = Math.min(duration, timeOf(cssWidth))
        context.font = '10px ui-monospace, Consolas, monospace'
        context.textBaseline = 'middle'
        let previousRight = -Infinity
        for (let time = first; time <= last + step; time += step) {
          const x = xOf(time) - scrollLeft
          if (x < GUTTER - 0.5 || x > cssWidth) continue
          const major = Math.abs(time / (step * 5) - Math.round(time / (step * 5))) < 1e-6
          context.fillStyle = palette.hairline
          context.fillRect(Math.round(x), major ? RULER_H - 9 : RULER_H - 5, 1, major ? 9 : 5)
          const label = formatTime(time, decimals)
          const width = context.measureText(label).width
          if (x + 3 + width > previousRight + 6 || x < previousRight) {
            context.fillStyle = palette.text
            context.fillText(label, x + 3, RULER_H / 2 - 1)
            previousRight = x + 3 + width
          }
        }
        context.fillStyle = palette.hairline
        context.fillRect(0, RULER_H - 0.5, cssWidth, 1)

        // The gutter: one cell per TRACK, each exactly as tall as its own row,
        // so the left part of the picture reads as the SAME track as the
        // waveform beside it. The name and the amplitude reading sit together in
        // the middle of the cell, which is what keeps them paired when the
        // reader drags the track height.
        for (let track = 0; track < trackRows; track += 1) {
          const top = trackTop(track)
          const centre = top + trackHeight / 2
          const name = channelLabel(track, channels)
          const reading = pointer !== null && pointer.track === track ? pointer.label : dbMode ? 'dBFS' : 'linear'
          const twoLines = trackHeight >= 42
          context.fillStyle = palette.track
          context.fillRect(0, top, GUTTER, trackHeight)
          context.font = '11px ui-monospace, Consolas, monospace'
          context.fillStyle = palette.textStrong
          if (name !== '' && (twoLines || reading === '')) context.fillText(name, 8, twoLines ? centre - 6 : centre)
          context.font = '9.5px ui-monospace, Consolas, monospace'
          context.fillStyle = palette.text
          context.fillText(reading, 8, twoLines ? centre + 8 : centre)
          // The resize handle IS this edge: a hairline at the bottom of every
          // track, drawn hotter while the pointer is on it, and the pointer
          // handlers below treat a press near it as the resize.
          context.fillStyle = pointer !== null && pointer.handle === track ? palette.envelope : palette.hairline
          context.fillRect(0, top + trackHeight - 0.5, GUTTER, 1)
        }
        context.fillStyle = palette.hairline
        context.fillRect(GUTTER - 0.5, 0, 1, cssHeight)

        // The playhead over everything.
        const playX = xOf(playhead) - scrollLeft
        if (playX >= GUTTER - 1 && playX <= cssWidth + 1) {
          context.fillStyle = palette.playhead
          context.fillRect(Math.round(playX), 0, 1, cssHeight)
        }
      }, [
        channels,
        contentHeight,
        dbMode,
        duration,
        facts.sampleRate,
        gain,
        palette,
        peaks,
        playhead,
        pointer,
        pxPerSecond,
        samples,
        selection,
        trackHeight,
        trackRows,
        trackStride,
      ])
      drawRef.current = draw

      // Repaint on every frame the pane scrolls: the canvas is the window, and
      // the scroll is the only thing that moves it.
      useEffect(() => {
        const scroller = scrollRef.current
        if (!scroller) return undefined
        const listener = () => {
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => drawRef.current && drawRef.current())
          else if (drawRef.current) drawRef.current()
        }
        scroller.addEventListener('scroll', listener, { passive: true })
        return () => scroller.removeEventListener('scroll', listener)
      }, [])

      // The canvas is the pane's width; a resize repaints and, while Fit is on,
      // re-fits - the picture follows the pane exactly like the image viewer's.
      useEffect(() => {
        const scroller = scrollRef.current
        if (!scroller) return undefined
        const measure = () => {
          if (fit) {
            const next = fitPps()
            ppsRef.current = next
            setPxPerSecond(next)
          }
          if (drawRef.current) drawRef.current()
        }
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(scroller)
        return () => observer.disconnect()
      }, [fit, fitPps])

      // The first paint of a new file fits, like the image viewer's.
      useEffect(() => {
        const next = fitPps()
        ppsRef.current = next
        setPxPerSecond(next)
        setFit(true)
        setSelection(null)
        setPlayhead(0)
      }, [fitPps, path])

      useEffect(() => {
        if (drawRef.current) drawRef.current()
      }, [draw])

      /**
       * Move the zoom, keeping the time under `anchor` exactly where it is: the
       * fraction is remembered before the layout changes and restored on the
       * next animation frame, after React has committed the new width.
       */
      const zoomTo = useCallback(
        (next, anchor) => {
          const scroller = scrollRef.current
          const clamped = Math.min(maxPps, Math.max(MIN_PPS, next))
          const current = ppsRef.current
          if (!scroller || current <= 0) {
            setFit(false)
            ppsRef.current = clamped
            setPxPerSecond(clamped)
            return
          }
          const rect = scroller.getBoundingClientRect()
          const anchorX = anchor && typeof anchor.x === 'number' ? anchor.x - rect.left : scroller.clientWidth / 2
          const timeAtAnchor = (scroller.scrollLeft + anchorX - GUTTER) / current
          setFit(false)
          ppsRef.current = clamped
          setPxPerSecond(clamped)
          const restore = () => {
            const element = scrollRef.current
            if (!element) return
            element.scrollLeft = Math.max(0, GUTTER + timeAtAnchor * clamped - anchorX)
            if (drawRef.current) drawRef.current()
          }
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore)
        },
        [maxPps],
      )

      /** Take the fit zoom now, wherever the pane is. */
      const applyFit = useCallback(() => {
        const next = fitPps()
        ppsRef.current = next
        setFit(true)
        setPxPerSecond(next)
        const scroller = scrollRef.current
        if (scroller) scroller.scrollLeft = 0
      }, [fitPps])

      /** One rung on the ladder; the ends clamp rather than wrap. */
      const stepZoom = useCallback(
        (direction, anchor) => {
          const current = ppsRef.current
          const ladder = PPS_STEPS.filter((step) => step <= maxPps * 1.0001)
          if (ladder.length === 0) ladder.push(MIN_PPS)
          if (direction > 0) {
            const next = ladder.find((step) => step > current + 1e-9)
            zoomTo(next === undefined ? current * 2 : next, anchor)
          } else {
            const below = ladder.filter((step) => step < current - 1e-9)
            zoomTo(below.length > 0 ? below[below.length - 1] : current / 2, anchor)
          }
        },
        [maxPps, zoomTo],
      )

      /** Step the amplitude gain, which is what Shift+wheel drives too. */
      const stepGain = useCallback((direction) => {
        setGain((current) => {
          const index = GAIN_STEPS.indexOf(current)
          const next = index < 0 ? 1 : Math.min(GAIN_STEPS.length - 1, Math.max(0, index + direction))
          return GAIN_STEPS[next]
        })
      }, [])

      // ---------------------------------------------------------------- audio
      const contextNow = useCallback(() => audioContextNow(), [])

      /** Stop whatever is playing, without touching the playhead. */
      const stopSource = useCallback(() => {
        const current = playRef.current
        playRef.current = null
        if (current) {
          try {
            current.source.onended = null
            current.source.stop()
          } catch (err) {
            /* already stopped */
          }
        }
      }, [])

      /**
       * The playback buffer: the file's own samples, or null when the file was
       * too big to hold - which is what disables the transport rather than
       * pretending to play.
       */
      const playbackBuffer = useCallback(() => {
        if (buffer !== null && buffer !== undefined) return buffer
        if (samples === null || samples === undefined) return null
        const context = contextNow()
        const created = context.createBuffer(samples.length, samples[0].length, facts.sampleRate)
        for (let channel = 0; channel < samples.length; channel += 1) created.getChannelData(channel).set(samples[channel])
        return created
      }, [buffer, contextNow, facts.sampleRate, samples])
      const bufferRef = useRef(null)
      const holdBuffer = useCallback(() => {
        if (bufferRef.current === null) bufferRef.current = playbackBuffer()
        return bufferRef.current
      }, [playbackBuffer])

      /** Start playing at a time, from the selection's start when there is one. */
      const play = useCallback(
        (from) => {
          const target = holdBuffer()
          if (!target) return
          const context = contextNow()
          if (typeof context.resume === 'function') context.resume()
          stopSource()
          const source = context.createBufferSource()
          source.buffer = target
          source.connect(context.destination)
          const start = Math.max(0, Math.min(duration - 0.001, from === undefined ? playhead : from))
          const looping = selection !== null && Math.abs(selection.to - selection.from) > 0.001
          if (looping) {
            source.loop = true
            source.loopStart = Math.min(selection.from, selection.to)
            source.loopEnd = Math.max(selection.from, selection.to)
          }
          source.start(0, start)
          playRef.current = { source: source, startedAt: context.currentTime, from: start, context: context }
          source.onended = () => {
            if (playRef.current && playRef.current.source === source) {
              playRef.current = null
              setPlaying(false)
              setPlayhead(looping ? Math.min(selection.from, selection.to) : duration)
            }
          }
          setPlaying(true)
        },
        [duration, holdBuffer, playhead, selection, stopSource],
      )

      const pause = useCallback(() => {
        const current = playRef.current
        if (current) {
          const elapsed = current.context.currentTime - current.startedAt
          setPlayhead(Math.min(duration, current.from + elapsed))
        }
        stopSource()
        setPlaying(false)
      }, [duration, stopSource])

      /**
       * The playhead follows the AUDIO CLOCK, not a CSS animation: the position
       * is `currentTime - startedAt + from`, which is what the AudioContext
       * itself is playing, so the line cannot drift from the sound.
       */
      useEffect(() => {
        if (!playing) return undefined
        let frame = 0
        const tick = () => {
          const current = playRef.current
          if (current) {
            const elapsed = current.context.currentTime - current.startedAt
            const loopLength = current.source.loop ? current.source.loopEnd - current.source.loopStart : 0
            let time = current.from + elapsed
            if (loopLength > 0) time = current.source.loopStart + ((time - current.source.loopStart) % loopLength)
            setPlayhead(time)
          }
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(tick)
        }
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(tick)
        return () => {
          if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
        }
      }, [playing])

      // A playing tab tears its source down when it goes away.
      useEffect(
        () => () => {
          stopSource()
        },
        [stopSource],
      )

      /** Keep the playhead in view while it plays. */
      useEffect(() => {
        if (!playing) return
        const scroller = scrollRef.current
        if (!scroller) return
        const x = GUTTER + playhead * pxPerSecond - scroller.scrollLeft
        if (x < GUTTER + 24 || x > scroller.clientWidth - 48) {
          scroller.scrollLeft = Math.max(0, GUTTER + playhead * pxPerSecond - scroller.clientWidth * 0.4)
        }
      }, [playhead, playing, pxPerSecond])

      // ------------------------------------------------------------- pointers
      /**
       * What is under one client point: the time, the TRACK, and whether the
       * press would land on a track's resize handle.
       */
      const pointAt = useCallback(
        (clientX, clientY) => {
          const canvas = canvasRef.current
          const scroller = scrollRef.current
          if (!canvas || !scroller) return null
          const rect = canvas.getBoundingClientRect()
          const canvasX = clientX - rect.left
          const canvasY = clientY - rect.top
          const contentX = canvasX + scroller.scrollLeft
          const time = Math.max(0, Math.min(duration, (contentX - GUTTER) / pxPerSecond))
          const row = canvasY - RULER_H
          const track = Math.floor(row / trackStride)
          const inside = track >= 0 && track < trackRows
          // A handle is the last few pixels of a track's own row (and the first
          // of the gap under it): near enough to the bottom edge to mean "this
          // edge", far enough from the middle that a selection still starts
          // where a reader expects it to.
          const offset = row - track * trackStride
          const handle = inside && offset >= trackHeight - HANDLE_GRAB ? track : -1
          return {
            time: time,
            track: inside ? track : null,
            handle: handle,
            inGutter: canvasX < GUTTER,
            inRuler: canvasY < RULER_H,
          }
        },
        [duration, pxPerSecond, trackHeight, trackRows, trackStride],
      )

      /** The amplitude at a time in one track, read from the finest pyramid level. */
      const amplitudeAt = useCallback(
        (time, track) => {
          const frame = Math.round(time * facts.sampleRate)
          if (samples !== null && samples !== undefined && samples[track] !== undefined && frame < samples[track].length) {
            return samples[track][frame]
          }
          const envelope = columnEnvelope(peaks.levels[0], Math.min(track, peaks.levels[0].mins.length - 1), frame, frame + 1)
          return envelope === null ? 0 : envelope.rms
        },
        [facts.sampleRate, peaks, samples],
      )

      const onPointerDown = useCallback(
        (event) => {
          const point = pointAt(event.clientX, event.clientY)
          if (!point || event.button !== 0) return
          const scroller = scrollRef.current
          const canvas = canvasRef.current
          if (!scroller) return
          if (point.handle >= 0) {
            // Any track's bottom edge resizes EVERY track: one shared height.
            dragRef.current = { kind: 'resize', y: event.clientY, height: trackHeight }
            if (canvas) canvas.style.cursor = 'ns-resize'
          } else if (point.inRuler || point.inGutter || event.altKey) {
            // The ruler is the pan handle (a waveform drag is a selection, which
            // is the gesture the surface is for); the gutter too.
            dragRef.current = { kind: 'pan', x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop }
            if (canvas) canvas.style.cursor = 'grabbing'
          } else {
            dragRef.current = { kind: 'select', from: point.time, to: point.time, moved: false }
            setSelection({ from: point.time, to: point.time })
            if (canvas) canvas.style.cursor = 'ew-resize'
          }
          try {
            canvasRef.current.setPointerCapture(event.pointerId)
          } catch (err) {
            /* an old browser: the move events still arrive over the canvas */
          }
        },
        [pointAt, trackHeight],
      )

      const onPointerMove = useCallback(
        (event) => {
          const point = pointAt(event.clientX, event.clientY)
          const drag = dragRef.current
          const scroller = scrollRef.current
          const canvas = canvasRef.current
          if (drag && drag.kind === 'pan' && scroller) {
            scroller.scrollLeft = drag.left - (event.clientX - drag.x)
            scroller.scrollTop = drag.top - (event.clientY - drag.y)
          } else if (drag && drag.kind === 'select' && point) {
            drag.to = point.time
            drag.moved = true
            setSelection({ from: drag.from, to: point.time })
          } else if (drag && drag.kind === 'resize') {
            const next = Math.max(MIN_TRACK_H, Math.min(MAX_TRACK_H, drag.height + (event.clientY - drag.y)))
            setTrackHeight(Math.round(next))
          } else if (canvas) {
            // The cursor says what a press will do HERE: a track's bottom edge
            // resizes, the ruler pans, a track selects. A static cursor is a
            // promise the surface does not keep.
            canvas.style.cursor =
              point && point.handle >= 0 ? 'ns-resize' : point && (point.inRuler || point.inGutter) ? 'grab' : 'crosshair'
          }
          if (point) {
            const value = point.track === null ? null : amplitudeAt(point.time, point.track)
            setPointer({
              time: point.time,
              track: point.track,
              handle: point.handle,
              label: value === null ? formatTime(point.time) : formatDb(value),
            })
          }
        },
        [amplitudeAt, pointAt],
      )

      const endDrag = useCallback(() => {
        const drag = dragRef.current
        dragRef.current = null
        const canvas = canvasRef.current
        if (canvas) canvas.style.cursor = 'crosshair'
        if (drag && drag.kind === 'select' && drag.moved === false) {
          // A click, not a drag: it seeks, exactly like a transport's own.
          setSelection(null)
          if (playing) play(drag.from)
          else setPlayhead(drag.from)
        }
      }, [play, playing])

      /** Ctrl/Cmd + wheel zooms at the pointer; Shift + wheel is amplitude. */
      const onWheel = useCallback(
        (event) => {
          const scroller = scrollRef.current
          if (!scroller) return
          if (event.ctrlKey || event.metaKey) {
            if (event.deltaY === 0) return
            event.preventDefault()
            const factor = event.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR
            // The ref, not the state: a pinch's events all land before the next
            // render, and every one of them must compound on the last.
            zoomTo(ppsRef.current * factor, { x: event.clientX, y: event.clientY })
            return
          }
          if (event.shiftKey) {
            if (event.deltaY === 0) return
            event.preventDefault()
            stepGain(event.deltaY < 0 ? 1 : -1)
            return
          }
          // A bare wheel scrolls the waveform sideways: this pane has no
          // vertical overflow to spend it on, and time is the axis here.
          const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
          if (delta === 0) return
          event.preventDefault()
          scroller.scrollLeft += delta
        },
        [stepGain, zoomTo],
      )
      wheelHandler.current = onWheel
      useEffect(() => {
        const scroller = scrollRef.current
        if (!scroller) return undefined
        // Native and NON-PASSIVE: React's own wheel listener is passive, so a
        // preventDefault inside it does nothing and the browser's Ctrl+wheel
        // page zoom would fire on top of ours.
        const listener = (event) => {
          const handler = wheelHandler.current
          if (typeof handler === 'function') handler(event)
        }
        scroller.addEventListener('wheel', listener, { passive: false })
        return () => scroller.removeEventListener('wheel', listener)
      }, [])

      const onKeyDown = useCallback(
        (event) => {
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
          const scroller = scrollRef.current
          if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault()
            if (playing) pause()
            else play()
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            stepZoom(1, null)
          } else if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            stepZoom(-1, null)
          } else if (event.key === '0') {
            event.preventDefault()
            applyFit()
          } else if (event.key === 'Home') {
            event.preventDefault()
            setPlayhead(0)
            if (scroller) scroller.scrollLeft = 0
          } else if (event.key === 'End') {
            event.preventDefault()
            setPlayhead(duration)
            if (scroller) scroller.scrollLeft = Math.max(0, GUTTER + duration * pxPerSecond - scroller.clientWidth)
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            // One screen pixel of time per press, which is the grain the reader
            // is actually looking at.
            event.preventDefault()
            const step = pxPerSecond > 0 ? 1 / pxPerSecond : 0.01
            const next = Math.max(0, Math.min(duration, playhead + (event.key === 'ArrowRight' ? step : -step)))
            setPlayhead(next)
            if (playing) play(next)
          }
        },
        [applyFit, duration, pause, play, playing, playhead, pxPerSecond, stepZoom],
      )

      // ------------------------------------------------------------ selection
      /** What the selection actually measures: peak and RMS across channels. */
      const selectionInfo = useMemo(() => {
        if (selection === null) return null
        const from = Math.max(0, Math.min(selection.from, selection.to))
        const to = Math.min(duration, Math.max(selection.from, selection.to))
        const seconds = to - from
        if (!(seconds > 0)) return null
        const firstFrame = Math.max(0, Math.floor(from * facts.sampleRate))
        const lastFrame = Math.min(facts.frames, Math.ceil(to * facts.sampleRate))
        const frames = lastFrame - firstFrame
        if (frames <= 0) return null
        // The samples when they are held and the window is not enormous: that
        // is the exact reading. Otherwise the peak pyramid answers, and the
        // status line names the bucket it answered from.
        if (samples !== null && samples !== undefined && frames <= MEASURE_SAMPLES) {
          let peak = 0
          let sumsq = 0
          for (let channel = 0; channel < samples.length; channel += 1) {
            const data = samples[channel]
            for (let frame = firstFrame; frame < lastFrame; frame += 1) {
              const value = data[frame]
              const magnitude = value < 0 ? -value : value
              if (magnitude > peak) peak = magnitude
              sumsq += value * value
            }
          }
          const total = frames * samples.length
          return { seconds: seconds, peak: peak, rms: Math.sqrt(sumsq / total), method: 'the samples' }
        }
        const level = pickLevel(peaks, frames / 1)
        let peak = 0
        let sumsq = 0
        let seen = 0
        for (let channel = 0; channel < level.mins.length; channel += 1) {
          const first = Math.max(0, Math.floor(firstFrame / level.bucket))
          const last = Math.min(level.count, Math.ceil(lastFrame / level.bucket))
          for (let index = first; index < last; index += 1) {
            const low = Math.abs(level.mins[channel][index])
            const high = Math.abs(level.maxs[channel][index])
            if (low > peak) peak = low
            if (high > peak) peak = high
            sumsq += level.rmss[channel][index] * level.rmss[channel][index]
            seen += 1
          }
        }
        return {
          seconds: seconds,
          peak: peak,
          rms: seen === 0 ? 0 : Math.sqrt(sumsq / seen),
          method: level.bucket + '-sample buckets',
        }
      }, [duration, facts.frames, facts.sampleRate, peaks, samples, selection])

      const atMin = pxPerSecond <= MIN_PPS + 1e-9
      const atMax = pxPerSecond >= maxPps - 1e-6
      const percent = duration > 0 ? Math.round((playhead / duration) * 1000) / 10 : 0

      return h(
        'div',
        { className: 'dsa-root', 'data-audio-viewer': name },
        h(
          'div',
          { className: 'dsa-tools' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn dsa-play',
              'data-audio-action': 'play',
              'data-active': playing ? 'true' : 'false',
              title: canPlay ? (playing ? 'Pause (Space)' : 'Play (Space)') : 'This file is too big to hold in the page, so it cannot be played here - the waveform is drawn from a streaming pass',
              disabled: !canPlay,
              onClick: () => (playing ? pause() : play()),
            },
            h(Glyph, { paths: playing ? ICONS.pause : ICONS.play }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-audio-action': 'zoom-out',
              title: 'Zoom out (-)',
              disabled: atMin,
              onClick: () => stepZoom(-1, null),
            },
            h(Glyph, { paths: ICONS.zoomOut }),
          ),
          h('span', { className: 'dsa-unit', 'data-audio-pps': String(Math.round(pxPerSecond)) }, Math.round(pxPerSecond) + ' px/s'),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-audio-action': 'zoom-in',
              title: 'Zoom in (+)',
              disabled: atMax,
              onClick: () => stepZoom(1, null),
            },
            h(Glyph, { paths: ICONS.zoomIn }),
          ),
          h(
            'button',
            { type: 'button', className: 'dsa-btn', 'data-audio-action': 'fit', 'data-active': fit ? 'true' : 'false', title: 'Fit the whole file in the pane (0)', onClick: applyFit },
            h(Glyph, { paths: ICONS.fit }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-audio-action': 'scale',
              'data-active': dbMode ? 'true' : 'false',
              title: 'The amplitude scale: dBFS draws the envelope against a 72 dB range, which is what shows what a compressor did',
              onClick: () => setDbMode((current) => !current),
            },
            dbMode ? 'dBFS' : 'linear',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-audio-action': 'clear',
              title: 'Clear the selection',
              disabled: selection === null,
              onClick: () => setSelection(null),
            },
            h(Glyph, { paths: ICONS.clear }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-audio-action': 'tracks',
              title: 'Show one track, or every track of the file again',
              disabled: channels < 2,
              onClick: () => setShownTracks((current) => (current > 1 ? 1 : channels)),
            },
            trackRows > 1 ? trackRows + ' tracks' : '1 track',
          ),
          h('span', { className: 'dsa-spacer' }),
          h(
            'span',
            { className: 'dsa-meta' },
            h('span', { 'data-audio-rate': String(facts.sampleRate) }, facts.sampleRate + ' Hz'),
            h('span', null, channels + (channels === 1 ? ' ch' : ' ch')),
            facts.bits > 0 ? h('span', null, facts.bits + '-bit') : null,
            h('span', { 'data-audio-duration': facts.duration.toFixed(3) }, formatTime(facts.duration)),
            humanBytes(size) === '' ? null : h('span', null, humanBytes(size)),
            h('span', { className: 'dsa-chip' }, FORMAT_NAMES[extensionOf(path)] === undefined ? 'AUDIO' : FORMAT_NAMES[extensionOf(path)]),
            h('span', { className: 'dsa-name', title: path }, name),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-btn',
              'data-audio-action': 'info',
              'data-active': showInfo ? 'true' : 'false',
              title: 'What the file and the decoder reported',
              onClick: () => setShowInfo((current) => !current),
            },
            h(Glyph, { paths: ICONS.info }),
          ),
          h(
            'button',
            { type: 'button', className: 'dsa-btn', 'data-audio-action': 'reload', title: 'Read the file again', onClick: onReload },
            h(Glyph, { paths: ICONS.reload }),
          ),
          h('span', { className: 'dsa-ver' }, PLUGIN_VERSION),
        ),
        h(
          'div',
          {
            className: 'dsa-scroll',
            ref: scrollRef,
            tabIndex: 0,
            role: 'group',
            'aria-label': 'Waveform: ' + name,
            onKeyDown,
          },
          h(
            'div',
            { className: 'dsa-spacerBox', 'data-audio-spacer': 'true', style: { width: contentWidth + 'px', height: contentHeight + 'px' } },
            h('canvas', {
              className: 'dsa-canvas',
              ref: canvasRef,
              'data-audio-canvas': 'true',
              // The WIDTH is deliberately not declared here: `draw` owns it,
              // since it must equal the PANE's width while the layout around it
              // is the file's. Declaring `100%` here would fight it, and the
              // CURSOR is owned by the pointer handlers, which know whether a
              // press would pan (the ruler) or select (a track).
              style: { height: contentHeight + 'px' },
              onPointerDown,
              onPointerMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
              onPointerLeave: () => {
                const canvas = canvasRef.current
                if (canvas) canvas.style.cursor = 'crosshair'
                setPointer(null)
              },
              onLostPointerCapture: endDrag,
            }),
          ),
        ),
        h(
          'div',
          { className: 'dsa-status', 'data-audio-status': 'true' },
          h('span', null, pointer !== null ? formatTime(pointer.time) : formatTime(playhead)),
          h('span', null, playing ? 'playing' : 'stopped'),
          h('span', null, percent + '%'),
          selectionInfo !== null
            ? h(
                'span',
                { className: 'dsa-statusSel' },
                'selection ' +
                  selectionInfo.seconds.toFixed(3) +
                  ' s \u00b7 peak ' +
                  formatDb(selectionInfo.peak) +
                  ' \u00b7 RMS ' +
                  formatDb(selectionInfo.rms) +
                  ' \u00b7 from ' +
                  selectionInfo.method,
              )
            : null,
          pointer !== null && pointer.track !== null
            ? h(
                'span',
                null,
                (channelLabel(pointer.track, channels) === '' ? '' : channelLabel(pointer.track, channels) + ' ') + pointer.label,
              )
            : null,
          h('span', { className: 'dsa-statusHint' }, 'Space plays \u00b7 drag selects \u00b7 click seeks \u00b7 Ctrl+wheel zooms \u00b7 wheel scrolls \u00b7 drag a track edge to resize'),
        ),
        showInfo ? h(InfoPanel, { facts: facts, size: size, source: source, levels: describeLevels(peaks) }) : null,
      )
    }

    /**
     * Amplitude to a track's y. In dBFS the envelope is drawn as MAGNITUDE
     * mirrored around the centre line (a dB scale cannot sign a zero crossing),
     * which is what the label in the gutter says.
     */
    function dbMagnitude(value) {
      const magnitude = Math.abs(value)
      if (!(magnitude > DB_FLOOR)) return 0
      const db = 20 * Math.log10(magnitude)
      return Math.max(0, Math.min(1, (db + DB_RANGE) / DB_RANGE))
    }

    function amplitudeToY(value, centre, halfHeight, dbMode, gain) {
      const scaled = value * gain
      if (dbMode) {
        const magnitude = dbMagnitude(scaled)
        return scaled < 0 ? centre + magnitude * halfHeight : centre - magnitude * halfHeight
      }
      const clamped = Math.max(-1, Math.min(1, scaled))
      return centre - clamped * halfHeight
    }

    /** The pyramid, in one line, for the details panel. */
    function describeLevels(peaks) {
      if (peaks === null || peaks === undefined) return 'not built'
      return peaks.levels.map((level) => level.bucket + ' samples/bucket').join(' \u2192 ')
    }

    // =====================================================================
    // 13. The audio console: this machine's devices, the output this page is
    //     told to play through, and a tone that proves it
    // =====================================================================
    //
    // WHERE THE BUTTON LIVES, AND WHY IT TAKES TWO REGISTRATIONS. The button
    // belongs in the left column's GLOBAL PANEL ROWS - `sidebar.panellist`, the
    // list whose one shipped occupant is "Plugins" - one row ABOVE Plugins. That
    // list renders in ASCENDING `order` and the shipped Plugins row registers at
    // 0, so this package asks for -1.
    //
    // The row itself is the SHELL's button: a registrant supplies a glyph and a
    // `label`, and the click calls `layout.selectPanel(<id>)`, which THROWS for
    // an id with no `main` panel behind it. So the row is registered WITH a seat
    // - a `main` panel keyed `audio` - and the seat is what opens this console in
    // the pack's shared dialog (dsh-modal), handing the central column back to
    // the panel the person came from when the dialog closes.
    //
    // That is the whole reason for the two halves: a left-bar button that opens
    // a MODAL, with the row keeping the shell's own full-width hit area. Nothing
    // here pins a hashed class name, intercepts a click inside another plugin's
    // button, or forks a core bundle. The seat also DEGRADES rather than fails: a
    // profile without dsh-modal draws the same console INLINE as an ordinary
    // page, which is a working surface instead of an unhandled exception.
    //
    // WHAT THE CONSOLE IS FOR. A browser plays its audio wherever the OPERATING
    // SYSTEM sends it, and a machine with a headset, a monitor with speakers and
    // a USB interface has three answers to that. The console lists what the
    // machine actually has (`enumerateDevices`), lets a person pick an output and
    // an input, ROUTES the page's audio there where the browser allows it
    // (`AudioContext.setSinkId` on the engine every player in this package shares,
    // `HTMLMediaElement.setSinkId` on the media elements in the document), and
    // plays a tone through the pick so the choice is verified by EAR rather than
    // by faith. The input side gets the same treatment: a live level meter off
    // the chosen microphone, with the browser's own report of what it opened.
    //
    // IT IS DELIBERATELY SMALL: a card per device, one frequency, one level, one
    // channel, Play. Every sentence the console does not have to say is one it
    // does not say - the routing caveat lives ONCE, in the output section, and
    // the status line is reserved for what went wrong.
    //
    // WHY THE OUTPUT PICK IS A BEST EFFORT, SAID PLAINLY IN THE UI: only
    // Chromium 110+ (and Opera 96+) exposes `AudioContext.setSinkId`, Chromium
    // 49-109 and Safari 17.4+ route a media ELEMENT only, and Firefox exposes
    // neither - so there the list is INFORMATION (what the machine has, where the
    // system default points) and the console says so in one sentence instead of
    // pretending the pick took effect.
    /** The left column's global-panel rows, and this package's seat in it. */
    const PANEL_SLOT = 'sidebar.panellist'
    /** The central column's keyed panels: the seat the row above needs. */
    const MAIN_SLOT = 'main'
    /** The id shared by the sidebar row, the main seat and layout.selectPanel. */
    const PANEL_ID = 'audio'
    /** The panel list sorts ASCENDING and Plugins registers at 0: this is above it. */
    const PANEL_ORDER = -1
    /** The pack's shared dialog surface (dsh-modal), resolved lazily at click time. */
    const MODAL_SERVICE = 'modals'
    /** The service other bundles read this page's choice through. */
    const SERVICE_NAME = 'audioDevices'
    /** Where the choice is remembered. Per browser, like the theme. */
    const STORAGE_KEY = 'dsh-audio.devices'
    /** The tone's own band, and the note a fresh console starts on. */
    const TONE_MIN_HZ = 20
    const TONE_MAX_HZ = 20000
    const TONE_DEFAULT_HZ = 440
    /** The level is a 0-100 slider on a SQUARE law, so half of it is -12 dB. */
    const TONE_LEVEL_DEFAULT = 50
    /** A fade at each end of a tone: a click is not a speaker test. */
    const TONE_FADE_MS = 5
    /** A steady tone stops itself here, so a forgotten one cannot drone on. */
    const TONE_MAX_SECONDS = 30
    /** The meter's analyser window, and how often the bar is redrawn. */
    const METER_FFT = 2048
    const METER_INTERVAL_MS = 60
    /** The meter's scale, in dB: below this the reading is the floor. */
    const METER_RANGE_DB = 60

    // ---------------------------------------------------------------------
    // The device list, as this package reads it
    // ---------------------------------------------------------------------
    /**
     * The device list the browser will hand over, or null where it will not.
     *
     * `navigator.mediaDevices` is ABSENT outside a secure context, and
     * `http://127.0.0.1` - what the harness serves - counts as one. So this is
     * about a deployment reached over a plain-HTTP LAN address, where the honest
     * answer is a sentence and not an empty list.
     */
    function mediaDevicesNow() {
      if (typeof navigator === 'undefined') return null
      const devices = navigator.mediaDevices
      return devices && typeof devices.enumerateDevices === 'function' ? devices : null
    }

    /**
     * One device list, in the shape the console reads.
     *
     * The default alias is folded onto the EMPTY id, so `''` always means
     * "wherever the system sends it" and every card's selection test is one
     * string comparison. A device the browser gives no name for is still a real
     * device, so it is kept with an empty label and the list reports that SOME
     * name is missing - which is what the "Show device names" control is for.
     */
    function normalizeDevices(list) {
      const outputs = []
      const inputs = []
      let unnamed = false
      const raw = Array.isArray(list) ? list : []
      for (const entry of raw) {
        if (entry === null || entry === undefined || typeof entry !== 'object') continue
        const kind = entry.kind === 'audiooutput' ? 'output' : entry.kind === 'audioinput' ? 'input' : ''
        if (kind === '') continue
        const label = typeof entry.label === 'string' ? entry.label.trim() : ''
        if (label === '') unnamed = true
        const id = typeof entry.deviceId === 'string' && entry.deviceId !== 'default' ? entry.deviceId : ''
        const device = {
          kind: kind,
          id: id,
          label: label,
          groupId: typeof entry.groupId === 'string' ? entry.groupId : '',
          isDefault: id === '',
        }
        if (kind === 'output') outputs.push(device)
        else inputs.push(device)
      }
      const byDefaultThenLabel = (left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
        return left.label.localeCompare(right.label)
      }
      return { outputs: outputs.sort(byDefaultThenLabel), inputs: inputs.sort(byDefaultThenLabel), unnamed: unnamed }
    }

    /** One card's name: the browser's label, or its position when there is none. */
    function deviceTitle(device, index) {
      const entry = device === null || device === undefined ? null : device
      if (entry !== null && typeof entry.label === 'string' && entry.label !== '') return entry.label
      return (entry !== null && entry.kind === 'input' ? 'Input ' : 'Output ') + String(index + 1)
    }

    /** A device id is a 64-character hash; six characters tell two cards apart. */
    function shortId(id) {
      const text = typeof id === 'string' ? id : ''
      if (text === '') return 'system default'
      return text.length > 8 ? text.slice(0, 6) + '\u2026' : text
    }

    /**
     * Where the "system default" card actually points, when the browser says so.
     *
     * Chromium reports the alias AND the real device it resolves to with the
     * SAME `groupId`, which is the only way to SHOW a person where the default
     * goes instead of leaving them to find out by ear.
     */
    function defaultTargetOf(devices) {
      const list = Array.isArray(devices) ? devices : []
      let alias = null
      for (const device of list) {
        if (device.isDefault === true && device.groupId !== '') {
          alias = device
          break
        }
      }
      if (alias === null) return ''
      for (const device of list) {
        if (device.isDefault !== true && device.groupId === alias.groupId && device.label !== '') return device.label
      }
      return ''
    }

    /** The label the person picked, or the words for a device that has gone. */
    function nameOfId(devices, id) {
      if (typeof id !== 'string' || id === '') return 'system default'
      const list = Array.isArray(devices) ? devices : []
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].id === id) return deviceTitle(list[index], index)
      }
      return 'a device that is no longer connected'
    }

    /**
     * Which way this page can send its audio to a CHOSEN output, from the two
     * facts that decide it. An environment object rather than the globals, so
     * every branch is a unit test instead of a browser matrix:
     *
     *   - `context` - `AudioContext.setSinkId` exists, which routes the Web Audio
     *     graph: the test tone AND the waveform player's own playback, because
     *     both play through the context this package shares;
     *   - `element` - only `HTMLMediaElement.setSinkId` exists, so the tone is
     *     played as a generated WAV through an `<audio>` element while the Web
     *     Audio graph keeps the system default;
     *   - `none` - neither exists, so the list is information and the tone plays
     *     wherever the system sends it.
     */
    function pickOutputStrategy(facts) {
      const source = facts === null || facts === undefined ? {} : facts
      if (source.contextSetSinkId === true) {
        return { kind: 'context', sentence: 'The tone and this app\u2019s own playback go to the output you pick.' }
      }
      if (source.elementSetSinkId === true) {
        return {
          kind: 'element',
          sentence:
            'This browser can route a media element but not its audio engine, so the TEST TONE follows your pick while the app\u2019s own Web Audio playback keeps the system default.',
        }
      }
      return {
        kind: 'none',
        sentence:
          'This browser gives a page no way to choose an output device, so a pick here is remembered and shown but the sound still goes wherever the system sends it \u2014 choose the output in the system mixer instead.',
      }
    }

    /** The strategy THIS page supports, read off the two prototypes. */
    function outputStrategyNow() {
      const scope = typeof window === 'undefined' ? {} : window
      const Ctor = scope.AudioContext === undefined ? scope.webkitAudioContext : scope.AudioContext
      const proto = Ctor === undefined || Ctor === null ? null : Ctor.prototype
      const elementCtor = scope.HTMLMediaElement
      const elementProto = elementCtor === undefined || elementCtor === null ? null : elementCtor.prototype
      return pickOutputStrategy({
        contextSetSinkId: proto !== null && typeof proto.setSinkId === 'function',
        elementSetSinkId: elementProto !== null && 'setSinkId' in elementProto,
      })
    }

    // ---------------------------------------------------------------------
    // The tone's numbers (pure)
    // ---------------------------------------------------------------------
    /** A level slider position as a gain: a SQUARE law, so half of it is -12 dB. */
    function gainForLevel(level) {
      const value = Number(level)
      const position = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)) / 100
      return position * position
    }

    /** ...and the same position in dBFS, for the label beside the slider. */
    function dbForLevel(level) {
      const gain = gainForLevel(level)
      return gain <= 0 ? -Infinity : 20 * Math.log10(gain)
    }

    /** A frequency a person typed, clamped to what a listener can hear. */
    function clampFrequency(value) {
      const hz = Math.round(Number(value))
      if (!Number.isFinite(hz) || hz <= 0) return TONE_DEFAULT_HZ
      return Math.max(TONE_MIN_HZ, Math.min(TONE_MAX_HZ, hz))
    }

    /** The stereo position one channel choice asks for. */
    function panForChannel(channel) {
      if (channel === 'left') return -1
      if (channel === 'right') return 1
      return 0
    }

    /**
     * The tone as SAMPLES, for the path where an `<audio>` element is the only
     * thing the browser will route: a sine at the chosen frequency and level,
     * placed where the channel choice asks for it.
     *
     * The ends are faded over `TONE_FADE_MS` because a waveform that starts at
     * full amplitude CLICKS, and a click at the start of a test tone reads as a
     * fault in the speaker being tested. The pan law is written out here rather
     * than taken from `StereoPannerNode`: left-only must be SILENT on the right,
     * and both must be full on both sides, which is what a channel check needs
     * and not what an equal-power law gives.
     */
    function toneChannels(options) {
      const source = options === null || options === undefined ? {} : options
      const rate = Number(source.sampleRate)
      const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : 48000
      const frequency = clampFrequency(source.frequency)
      const gain = gainForLevel(source.level === undefined ? TONE_LEVEL_DEFAULT : source.level)
      const seconds = Number(source.seconds) > 0 ? Number(source.seconds) : TONE_MAX_SECONDS
      const frames = Math.max(1, Math.round(seconds * sampleRate))
      const fade = Math.max(1, Math.round((TONE_FADE_MS / 1000) * sampleRate))
      const pan = panForChannel(source.channel)
      const leftGain = pan <= 0 ? 1 : 1 - pan
      const rightGain = pan >= 0 ? 1 : 1 + pan
      const left = new Float32Array(frames)
      const right = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        // Exactly ZERO at the first and the last sample: a waveform that starts
        // or ends anywhere else in its cycle is a click, and a click at the
        // start of a test tone reads as a fault in the speaker being tested.
        const head = Math.min(1, frame / fade)
        const tail = Math.min(1, (frames - 1 - frame) / fade)
        const envelope = Math.max(0, Math.min(head, tail))
        const sample = Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * gain * envelope
        left[frame] = sample * leftGain
        right[frame] = sample * rightGain
      }
      return [left, right]
    }

    /**
     * One RIFF/WAVE file from Float32 channels - 16-bit PCM, interleaved.
     *
     * The OTHER DIRECTION of section 3, and it is here rather than in a helper
     * module because exactly one caller needs it: the `element` strategy, where
     * the test tone has to exist as a FILE for an `<audio>` element to route it.
     * The tracked check builds a tone with it, reads it back with `parseWav` and
     * decodes it with `decodePcm`, which is how the encoder is kept honest
     * against the decoder sitting next to it.
     */
    function encodeWav(channels, sampleRate) {
      const list = Array.isArray(channels) ? channels : []
      const count = list.length
      const frames = count === 0 ? 0 : list[0].length
      const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 48000
      const bytes = new Uint8Array(44 + frames * count * 2)
      const view = new DataView(bytes.buffer)
      const ascii = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
      }
      ascii(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      ascii(8, 'WAVE')
      ascii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, count, true)
      view.setUint32(24, rate, true)
      view.setUint32(28, rate * count * 2, true)
      view.setUint16(32, count * 2, true)
      view.setUint16(34, 16, true)
      ascii(36, 'data')
      view.setUint32(40, frames * count * 2, true)
      let at = 44
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < count; channel += 1) {
          const value = Math.max(-1, Math.min(1, list[channel][frame]))
          view.setInt16(at, Math.round(value * 32767), true)
          at += 2
        }
      }
      return bytes
    }

    // ---------------------------------------------------------------------
    // The meter's numbers (pure)
    // ---------------------------------------------------------------------
    /**
     * The RMS of one analyser frame. `AnalyserNode.getByteTimeDomainData` writes
     * the waveform as unsigned bytes about 128, so 128 is what the subtraction
     * takes back out - what comes out is an AMPLITUDE in 0..1, not a dB reading.
     */
    function rmsOfWaveform(values) {
      const data = values !== null && values !== undefined && typeof values.length === 'number' ? values : []
      if (data.length === 0) return 0
      let sum = 0
      for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] - 128) / 128
        sum += value * value
      }
      return Math.sqrt(sum / data.length)
    }

    /** A meter bar's width for one amplitude, on a dB scale, so a quiet room still moves it. */
    function levelBar(level) {
      const db = amplitudeToDb(level)
      if (db === null) return 0
      return Math.max(0, Math.min(1, (db + METER_RANGE_DB) / METER_RANGE_DB))
    }

    /** `echoCancellation` as words a person reads. */
    function camelWords(text) {
      const value = typeof text === 'string' ? text : ''
      const spaced = value.replace(/([a-z0-9])([A-Z])/g, (match, head, tail) => head + ' ' + tail.toLowerCase())
      return spaced === '' ? '' : spaced.charAt(0).toLowerCase() + spaced.slice(1)
    }

    /**
     * What the browser says the live capture IS, straight off the track: which
     * microphone matters less than whether it opened at 48 kHz with echo
     * cancellation on - and `getSettings` and `getCapabilities` are both recent
     * enough to need their own guards.
     */
    function describeStream(track) {
      const rows = []
      if (track === null || track === undefined) return rows
      let settings = null
      let capabilities = null
      try {
        settings = typeof track.getSettings === 'function' ? track.getSettings() : null
      } catch (err) {
        settings = null
      }
      try {
        capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null
      } catch (err) {
        capabilities = null
      }
      if (settings !== null && typeof settings === 'object') {
        if (typeof settings.sampleRate === 'number') rows.push(['sample rate', settings.sampleRate + ' Hz'])
        if (typeof settings.channelCount === 'number') rows.push(['channels', String(settings.channelCount)])
        if (typeof settings.latency === 'number') rows.push(['latency', (settings.latency * 1000).toFixed(1) + ' ms'])
        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
          if (typeof settings[key] === 'boolean') rows.push([camelWords(key), settings[key] ? 'on' : 'off'])
        }
      }
      if (capabilities !== null && typeof capabilities === 'object') {
        const rates = capabilities.sampleRate
        if (rates !== null && rates !== undefined && typeof rates === 'object' && typeof rates.min === 'number' && typeof rates.max === 'number') {
          rows.push(['device rates', rates.min + '\u2013' + rates.max + ' Hz'])
        }
      }
      return rows
    }

    /** The constraints for one chosen input: that exact device, or the system default. */
    function captureConstraints(inputId) {
      return typeof inputId === 'string' && inputId !== '' ? { audio: { deviceId: { exact: inputId } } } : { audio: true }
    }

    // ---------------------------------------------------------------------
    // The remembered choice
    // ---------------------------------------------------------------------
    /**
     * The choice as stored, guarded twice: the storage object is passed IN (so a
     * check drives it with a double) and every access is wrapped, because
     * `localStorage` THROWS rather than returning null when a browser blocks
     * storage for the page.
     */
    function readChoice(storage) {
      const empty = { outputId: '', inputId: '' }
      if (storage === null || storage === undefined || typeof storage.getItem !== 'function') return empty
      let raw = null
      try {
        raw = storage.getItem(STORAGE_KEY)
      } catch (err) {
        return empty
      }
      if (typeof raw !== 'string' || raw === '') return empty
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        return empty
      }
      if (parsed === null || typeof parsed !== 'object') return empty
      return {
        outputId: typeof parsed.outputId === 'string' ? parsed.outputId : '',
        inputId: typeof parsed.inputId === 'string' ? parsed.inputId : '',
      }
    }

    function writeChoice(storage, choice) {
      if (storage === null || storage === undefined || typeof storage.setItem !== 'function') return
      const source = choice === null || choice === undefined ? {} : choice
      const value = {
        outputId: typeof source.outputId === 'string' ? source.outputId : '',
        inputId: typeof source.inputId === 'string' ? source.inputId : '',
      }
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch (err) {
        /* a blocked or full store is not a failure of anything this console does */
      }
    }

    function storageNow() {
      if (typeof window === 'undefined') return null
      try {
        return window.localStorage
      } catch (err) {
        return null
      }
    }

    // ---------------------------------------------------------------------
    // This page's own state, and the service that publishes it
    // ---------------------------------------------------------------------
    /** The activated context, for the two services this section resolves lazily. */
    let pluginCtx = null

    /** Resolve one client service, or null when this profile has no such plugin. */
    function serviceNow(name) {
      const ctx = pluginCtx
      if (ctx === null || typeof ctx.get !== 'function') return null
      try {
        const service = ctx.get(name)
        return service === undefined ? null : service
      } catch (err) {
        return null
      }
    }

    function messageOf(error) {
      if (error === null || error === undefined) return 'Something went wrong.'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    /**
     * The output this page plays through, as the session knows it.
     *
     * `null` until the storage is read for the first time, so a bundle load in a
     * document with no storage cannot fail - which is exactly the fake DOM the
     * tracked check loads this bundle into.
     */
    let sessionOutputId = null
    function chosenOutputId() {
      if (sessionOutputId === null) sessionOutputId = readChoice(storageNow()).outputId
      return sessionOutputId
    }

    /** What the `audioDevices` service answers: the last thing the console saw. */
    const seenDevices = { phase: 'idle', strategy: 'none', outputId: '', inputId: '', outputs: [], inputs: [], unnamed: false }
    const seenListeners = new Set()

    function seenSnapshot() {
      return {
        phase: seenDevices.phase,
        strategy: seenDevices.strategy,
        outputId: seenDevices.outputId,
        inputId: seenDevices.inputId,
        outputs: seenDevices.outputs.slice(),
        inputs: seenDevices.inputs.slice(),
        unnamed: seenDevices.unnamed,
      }
    }

    /** Publish one patch to the service's subscribers, never letting one break the rest. */
    function publishSeen(patch) {
      if (patch !== null && patch !== undefined && typeof patch === 'object') {
        if (Array.isArray(patch.outputs)) seenDevices.outputs = patch.outputs
        if (Array.isArray(patch.inputs)) seenDevices.inputs = patch.inputs
        for (const key of ['phase', 'strategy', 'outputId', 'inputId']) {
          if (typeof patch[key] === 'string') seenDevices[key] = patch[key]
        }
        if (typeof patch.unnamed === 'boolean') seenDevices.unnamed = patch.unnamed
      }
      const snapshot = seenSnapshot()
      for (const listener of Array.from(seenListeners)) {
        try {
          listener(snapshot)
        } catch (err) {
          /* a subscriber's own failure is not this console's */
        }
      }
    }

    /**
     * The service another bundle reads: what this page can see, what it is set
     * to, and the one call a plugin that owns its own audio graph needs.
     *
     * READ-ONLY ON PURPOSE. The output is a device the PERSON is sitting next
     * to, so choosing it happens in the console and nowhere else; a bundle that
     * wants a different output asks the person. `applyTo` is the exception,
     * because a plugin with its own `AudioContext` (or its own `<audio>` element)
     * has to be told where this page is playing.
     */
    function audioDevicesFace() {
      return {
        snapshot: seenSnapshot,
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          seenListeners.add(listener)
          return () => {
            seenListeners.delete(listener)
          }
        },
        sinkId: chosenOutputId,
        applyTo(target) {
          if (target === null || target === undefined || typeof target.setSinkId !== 'function') return Promise.resolve([])
          try {
            const pending = target.setSinkId(chosenOutputId())
            return pending !== null && pending !== undefined && typeof pending.then === 'function' ? pending.then(() => [], (err) => [messageOf(err)]) : Promise.resolve([])
          } catch (err) {
            return Promise.resolve([messageOf(err)])
          }
        },
        refresh() {
          return enumerateNow()
        },
      }
    }

    // ---------------------------------------------------------------------
    // Enumerating, routing, and following the machine's own changes
    // ---------------------------------------------------------------------
    /**
     * Ask the browser for the device list, as `{ ok, outputs, inputs, unnamed }`
     * or `{ ok: false, message }` - never a throw, because the caller is a React
     * effect and an effect that throws takes the surface down with it.
     */
    async function enumerateNow() {
      const devices = mediaDevicesNow()
      if (devices === null) {
        return {
          ok: false,
          message:
            'This page is not a secure context, so the browser exposes no device list at all. The harness serves http://127.0.0.1, which counts as secure; a LAN address over plain HTTP does not.',
        }
      }
      try {
        const normalized = normalizeDevices(await devices.enumerateDevices())
        return { ok: true, outputs: normalized.outputs, inputs: normalized.inputs, unnamed: normalized.unnamed }
      } catch (err) {
        return { ok: false, message: 'The browser refused to list the audio devices: ' + messageOf(err) }
      }
    }

    /** Re-enumerate when the machine's devices change: a headset plugged in is a new list. */
    function subscribeDeviceChange(onChange) {
      const devices = mediaDevicesNow()
      if (devices === null || typeof devices.addEventListener !== 'function') return () => {}
      const listener = () => {
        onChange()
      }
      devices.addEventListener('devicechange', listener)
      return () => {
        try {
          devices.removeEventListener('devicechange', listener)
        } catch (err) {
          /* the list went away with the plugin */
        }
      }
    }

    /**
     * Send this page's audio to one output, everywhere the page can: the shared
     * AudioContext (the test tone AND the waveform player, which play through
     * it) and every media element already mounted, which is how the shipped
     * preview's own MP3 player follows the pick.
     *
     * Best effort by construction: `setSinkId` rejects when the device has gone
     * away or the page is not allowed to pick, and the returned refusals are what
     * the console REPORTS instead of leaving a silent no-op. A context is never
     * created here to set a sink on - opening an audio device to change where
     * nothing is playing is a cost with no benefit.
     */
    async function applySinkEverywhere(sinkId) {
      const failures = []
      const id = typeof sinkId === 'string' ? sinkId : ''
      if (audioContext !== null && typeof audioContext.setSinkId === 'function') {
        try {
          await audioContext.setSinkId(id)
        } catch (err) {
          failures.push('the audio engine refused: ' + messageOf(err))
        }
      }
      const elements =
        typeof document === 'undefined' || typeof document.querySelectorAll !== 'function' ? [] : Array.from(document.querySelectorAll('audio,video'))
      for (const element of elements) {
        if (element === null || element === undefined || typeof element.setSinkId !== 'function') continue
        try {
          await element.setSinkId(id)
        } catch (err) {
          failures.push('a media player refused: ' + messageOf(err))
        }
      }
      return failures
    }

    /** A context created AFTER the choice was made still honours it. */
    function applyChosenSink(context) {
      if (context === null || context === undefined || typeof context.setSinkId !== 'function') return
      const id = chosenOutputId()
      if (id === '') return
      try {
        const pending = context.setSinkId(id)
        if (pending !== null && pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
      } catch (err) {
        /* the console reports a refusal when a PERSON makes the choice; this is a restore */
      }
    }

    /**
     * Every media element that starts playing joins the chosen output.
     *
     * WHY A LISTENER AND NOT A SWEEP: a player mounted AFTER the choice was made
     * (any tab that opens a file) has never heard about it, and `play` does not
     * bubble - but it does CAPTURE, so one listener on the document catches every
     * media element the page will ever start. The device check keeps a player
     * that is already on the right output from being re-routed, and a refusal is
     * swallowed because this is a restore, not a request a person just made.
     */
    function watchMediaElements() {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {}
      const onPlay = (event) => {
        const element = event.target
        if (element === null || element === undefined || typeof element.setSinkId !== 'function') return
        const id = chosenOutputId()
        if (id === '') return
        let current = ''
        try {
          current = typeof element.sinkId === 'string' ? element.sinkId : ''
        } catch (err) {
          current = ''
        }
        if (current === id) return
        try {
          const pending = element.setSinkId(id)
          if (pending !== null && pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
        } catch (err) {
          /* a refusal here is not something a person asked for */
        }
      }
      document.addEventListener('play', onPlay, true)
      return () => {
        try {
          document.removeEventListener('play', onPlay, true)
        } catch (err) {
          /* the document went away first */
        }
      }
    }

    // ---------------------------------------------------------------------
    // The tone itself
    // ---------------------------------------------------------------------
    /**
     * A tone on the app's own AudioContext: one oscillator through a gain that
     * fades in and out. This is the path that reaches a CHOSEN output, because
     * `AudioContext.setSinkId` moves this whole graph - and it is the graph the
     * waveform player already plays through, which is why the choice made in the
     * console is the choice the rest of this package obeys.
     *
     * The oscillator stops ITSELF after `TONE_MAX_SECONDS`, so a forgotten test
     * tone cannot drone on in a meeting. `onended` is what tells the console the
     * sound stopped.
     */
    function contextTone(options) {
      const context = audioContextNow()
      if (typeof context.resume === 'function') context.resume()
      const now = context.currentTime
      const oscillator = context.createOscillator()
      oscillator.type = 'sine'
      oscillator.frequency.value = clampFrequency(options.frequency)
      const gain = context.createGain()
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainForLevel(options.level)), now + TONE_FADE_MS / 1000)
      let tail = gain
      if (typeof context.createStereoPanner === 'function') {
        const panner = context.createStereoPanner()
        panner.pan.value = panForChannel(options.channel)
        gain.connect(panner)
        tail = panner
      }
      tail.connect(context.destination)
      oscillator.connect(gain)
      const endsAt = now + TONE_MAX_SECONDS
      oscillator.start(now)
      oscillator.stop(endsAt)
      oscillator.onended = () => {
        if (typeof options.onEnded === 'function') options.onEnded()
      }
      let stopped = false
      return {
        via: 'webaudio',
        stop() {
          if (stopped) return
          stopped = true
          const at = context.currentTime
          try {
            gain.gain.cancelScheduledValues(at)
            gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), at)
            gain.gain.linearRampToValueAtTime(0.0001, at + TONE_FADE_MS / 1000)
            oscillator.stop(at + TONE_FADE_MS / 1000 + 0.02)
          } catch (err) {
            /* already stopped */
          }
        },
      }
    }

    /**
     * The same tone as a generated WAV through an `<audio>` element - the path
     * for a browser that routes media elements but not the audio engine.
     *
     * The frequency, the level and the channel are BAKED IN, which is why the
     * console freezes its controls while this path plays: there is no live graph
     * to turn a knob on, and pretending otherwise would be a control that does
     * nothing.
     */
    function elementTone(options) {
      // The rate this page already plays at, when it has an engine - and 48 kHz,
      // a legal rate everywhere, when it does not. A context is NEVER created
      // here just to read this number: the element path does not play through
      // one, so opening an audio device for it would be a cost with no benefit.
      let sampleRate = 48000
      const existing = audioContext
      if (existing !== null && typeof existing.sampleRate === 'number' && existing.sampleRate > 0) sampleRate = existing.sampleRate
      const channels = toneChannels({
        frequency: options.frequency,
        level: options.level,
        channel: options.channel,
        sampleRate: sampleRate,
      })
      const url = URL.createObjectURL(new Blob([encodeWav(channels, sampleRate)], { type: 'audio/wav' }))
      const element = new Audio()
      element.loop = true
      element.src = url
      let stopped = false
      const finish = (ended) => {
        if (stopped) return
        stopped = true
        try {
          element.pause()
        } catch (err) {
          /* already paused */
        }
        try {
          URL.revokeObjectURL(url)
        } catch (err) {
          /* already revoked */
        }
        if (ended === true && typeof options.onEnded === 'function') options.onEnded()
      }
      element.onended = () => {
        finish(true)
      }
      const begin = async () => {
        try {
          const id = chosenOutputId()
          if (id !== '' && typeof element.setSinkId === 'function') await element.setSinkId(id)
          await element.play()
        } catch (err) {
          finish(false)
          if (typeof options.onError === 'function') options.onError('The tone could not start: ' + messageOf(err))
        }
      }
      begin()
      return {
        via: 'element',
        stop() {
          finish(false)
        },
      }
    }

    /**
     * Start the test tone by whichever route this page has, as
     * `{ ok: true, handle }` or `{ ok: false, message }`.
     */
    function startTone(options) {
      const source = options === null || options === undefined ? {} : options
      try {
        return { ok: true, handle: source.strategy === 'element' ? elementTone(source) : contextTone(source) }
      } catch (err) {
        return { ok: false, message: 'The tone could not start: ' + messageOf(err) }
      }
    }

    // ---------------------------------------------------------------------
    // The console, drawn
    // ---------------------------------------------------------------------
    /** The speaker glyph: the left column's row, and every section's mark. */
    function SpeakerGlyph(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', { d: 'M2.4 6.1h2.1l3-2.5v8.8l-3-2.5H2.4z' }),
        h('path', { d: 'M10.2 6a2.8 2.8 0 0 1 0 4' }),
        h('path', { d: 'M12.3 4.1a5.4 5.4 0 0 1 0 7.8' }),
      )
    }

    /**
     * The left column's row: the glyph the shell draws inside its own button,
     * plus the ONE subscription this feature needs from a component.
     *
     * WHY THE WATCHER LIVES HERE. `layout.selectPanel('audio')` is what the row's
     * click does, so by the time the seat mounts the store already says `audio`
     * and the value that was there BEFORE it is gone - and only `layout` knows,
     * because it owns `panelInfo`. `layout` may also not be applied yet when this
     * bundle applies (client plugins arrive in boot-graph order), so this cannot
     * be done once at activation. The row is the one component that is mounted
     * from boot, long after the sidebar (and therefore layout) exists, and it is
     * exactly the thing whose click changes the answer.
     */
    function AudioPanelRow(props) {
      useEffect(() => watchPanels(), [])
      return h('span', { className: 'dsa-panelGlyph' }, h(SpeakerGlyph, { size: props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16 }))
    }

    /** One section's heading: a title, the count, and room for one control. */
    function SectionHead(props) {
      return h(
        'div',
        { className: 'dsa-devHead' },
        h('span', { className: 'dsa-devTitle' }, props.title),
        h('span', { className: 'dsa-devCount' }, props.count),
        h('span', { className: 'dsa-spacer' }),
        props.children === undefined ? null : props.children,
      )
    }

    /** One key/value line of the console's own facts. */
    function FactRow(props) {
      return h('div', { className: 'dsa-factRow' }, h('span', { className: 'dsa-factKey' }, props.label), h('span', { className: 'dsa-factVal' }, props.value))
    }

    /**
     * ONE KIND OF DEVICE, as cards.
     *
     * Every card is a button, because picking one is the point, and the card that
     * is picked wears the accent border. A card this browser will not let a page
     * route is still DRAWN - the machine has that device, and knowing the list is
     * what makes the system-mixer advice actionable - but it is disabled, with the
     * reason in its title.
     */
    function DeviceSection(props) {
      const devices = Array.isArray(props.devices) ? props.devices : []
      const target = defaultTargetOf(devices)
      const noun = props.kind === 'input' ? 'input' : 'output'
      return h(
        'section',
        { className: 'dsa-devSection', 'data-audio-section': props.kind },
        h(
          SectionHead,
          { title: props.title, count: devices.length === 0 ? 'none reported' : devices.length + (devices.length === 1 ? ' device' : ' devices') },
          props.head === undefined || props.head === null ? null : props.head,
        ),
        props.note === undefined || props.note === '' ? null : h('p', { className: 'dsa-devNote' }, props.note),
        h(
          'div',
          { className: 'dsa-cards', role: 'list' },
          devices.length === 0 ? h('div', { className: 'dsa-devEmpty' }, props.empty) : null,
          devices.map((device, index) =>
            h(
              'button',
              {
                key: device.id === '' ? 'default' : device.id + '#' + String(index),
                type: 'button',
                role: 'listitem',
                className: 'dsa-card',
                'data-audio-device': device.id === '' ? 'default' : device.id,
                'data-device-kind': props.kind,
                'data-active': device.id === props.selectedId ? 'true' : undefined,
                disabled: props.disabled === true,
                title: props.disabled === true ? props.disabledReason : 'Send this app\u2019s ' + noun + ' here',
                onClick: () => props.onSelect(device.id),
              },
              h('span', { className: 'dsa-cardName' }, deviceTitle(device, index)),
              h(
                'span',
                { className: 'dsa-cardMeta' },
                device.isDefault ? (target === '' ? 'system default' : 'system default \u2192 ' + target) : shortId(device.id),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * The test tone's controls: one frequency, one level, one channel.
     *
     * The controls FREEZE while the tone plays (and the note says why) rather
     * than pretending to be live: on the Web Audio path the parameters could be
     * changed under a running oscillator, but on the generated-WAV path they are
     * baked into the sound, and a control that works on one browser and not
     * another is worse than one that is honestly disabled.
     */
    function ToneSection(props) {
      const tone = props.tone
      const frozen = tone.playing === true && props.live !== true
      const level = dbForLevel(tone.level)
      return h(
        'section',
        { className: 'dsa-devSection', 'data-audio-section': 'tone' },
        h(SectionHead, { title: 'Test tone', count: props.target }, null),
        h(
          'div',
          { className: 'dsa-toneRow' },
          h('span', { className: 'dsa-toneLabel' }, 'Frequency'),
          h('input', {
            className: 'dsa-toneHz',
            type: 'number',
            min: TONE_MIN_HZ,
            max: TONE_MAX_HZ,
            step: 1,
            value: String(tone.frequency),
            'aria-label': 'Tone frequency in hertz',
            disabled: frozen === true,
            onChange: (event) => props.onFrequency(clampFrequency(event.target.value)),
          }),
          h('span', { className: 'dsa-toneUnit' }, 'Hz'),
        ),
        h(
          'div',
          { className: 'dsa-toneRow' },
          h('span', { className: 'dsa-toneLabel' }, 'Level'),
          h('input', {
            className: 'dsa-toneRange',
            type: 'range',
            min: 0,
            max: 100,
            step: 1,
            value: String(tone.level),
            'aria-label': 'Tone level',
            disabled: frozen === true,
            onChange: (event) => props.onLevel(Number(event.target.value)),
          }),
          h('span', { className: 'dsa-toneUnit' }, level <= -100 ? 'silent' : level.toFixed(1) + ' dB'),
        ),
        h(
          'div',
          { className: 'dsa-toneRow' },
          h('span', { className: 'dsa-toneLabel' }, 'Channel'),
          ['both', 'left', 'right'].map((channel) =>
            h(
              'button',
              {
                key: channel,
                type: 'button',
                className: 'dsa-btn',
                'data-audio-channel': channel,
                'data-active': tone.channel === channel ? 'true' : undefined,
                disabled: frozen === true,
                onClick: () => props.onChannel(channel),
              },
              channel === 'both' ? 'Both' : channel === 'left' ? 'Left' : 'Right',
            ),
          ),
          h('span', { className: 'dsa-spacer' }),
          h(
            'button',
            { type: 'button', className: 'dsa-btn dsa-primary', 'data-audio-action': 'tone', onClick: props.onToggle },
            tone.playing ? 'Stop' : 'Play tone',
          ),
        ),
        frozen === true
          ? h('p', { className: 'dsa-devNote', 'data-audio-note': 'frozen' }, 'This browser applies the tone\u2019s settings when it starts, so Stop it to change them.')
          : null,
      )
    }

    /**
     * The input side: a live meter off the chosen microphone, and the browser's
     * own account of the capture it opened.
     *
     * The meter is an EXTRA sink on its own audio graph and is never connected to
     * a destination, so the room can never feed back through it.
     */
    function InputTestSection(props) {
      const meter = props.meter
      const live = meter.phase === 'live'
      const starting = meter.phase === 'starting'
      return h(
        'section',
        { className: 'dsa-devSection', 'data-audio-section': 'meter' },
        h(SectionHead, { title: 'Input level', count: live ? formatDb(meter.level) : starting ? 'opening\u2026' : 'not open' }, null),
        h('div', { className: 'dsa-meter', 'data-audio-meter': 'true' }, h('div', { className: 'dsa-meterFill', style: { width: String(Math.round(levelBar(meter.level) * 100)) + '%' } })),
        h('p', { className: 'dsa-devNote' }, props.sentence),
        meter.error === '' ? null : h('p', { className: 'dsa-devNote dsa-warnState' }, meter.error),
        h(
          'div',
          { className: 'dsa-facts' },
          meter.rows.map((row) =>
            h('div', { className: 'dsa-factRow', key: row[0] }, h('span', { className: 'dsa-factKey' }, row[0]), h('span', { className: 'dsa-factVal' }, row[1])),
          ),
        ),
        h(
          'div',
          { className: 'dsa-toneRow' },
          h(
            'button',
            {
              type: 'button',
              className: live || starting ? 'dsa-btn' : 'dsa-btn dsa-primary',
              'data-audio-action': 'input-test',
              disabled: starting === true,
              onClick: live ? props.onStop : props.onStart,
            },
            live ? 'Stop listening' : starting ? 'Opening\u2026' : 'Listen to this input',
          ),
          h('span', { className: 'dsa-toneUnit' }, 'peak ' + formatDb(meter.peak)),
        ),
      )
    }

    /**
     * The console as MARKUP: every number, list and sentence arrives as a prop.
     *
     * That is what makes it verifiable - the tracked check renders THIS with
     * hand-built devices and asserts the cards, the marks, the frozen controls
     * and the sentences, with no browser, no microphone and no audio device
     * anywhere near the run. The stateful half below owns everything else.
     */
    function AudioConsoleView(props) {
      const state = props.state
      const choice = props.choice
      const routing = props.routing
      const count = state.phase === 'ready' ? String(state.outputs.length) + ' out \u00b7 ' + String(state.inputs.length) + ' in' : ''
      return h(
        'div',
        { className: 'dsa-console', 'data-audio-console': 'true' },
        h(
          'div',
          { className: 'dsa-consoleBar' },
          h('span', { className: 'dsa-consoleTitle' }, 'Audio'),
          h('span', { className: 'dsa-devCount' }, count),
          h('span', { className: 'dsa-spacer' }),
          // The bundle's version, in plain sight for the same reason the skills
          // browser prints its own: after a reload it is the one way to tell "the
          // fix is live" from "the harness is still serving the old bundle".
          h('span', { className: 'dsa-ver', title: 'dsh-audio client bundle version' }, 'v' + PLUGIN_VERSION),
          h('button', { type: 'button', className: 'dsa-btn', 'data-audio-action': 'reload', disabled: state.phase === 'loading', onClick: props.onReload }, 'Reload'),
          h('button', { type: 'button', className: 'dsa-btn', 'data-audio-action': 'close', onClick: props.onClose }, 'Close'),
        ),
        props.status === null || props.status === undefined
          ? null
          : h('div', { className: 'dsa-consoleStatus' }, h('p', { className: 'dsa-devNote', 'data-audio-status': props.status.tone }, props.status.message)),
        h(
          'div',
          { className: 'dsa-consoleBody' },
          h(
            'div',
            { className: 'dsa-consoleCol' },
            state.phase === 'error' ? h('p', { className: 'dsa-devNote dsa-warnState' }, state.error) : null,
            state.phase === 'loading' ? h('p', { className: 'dsa-devNote' }, 'Asking the browser what this machine has\u2026') : null,
            h(DeviceSection, {
              kind: 'output',
              title: 'Audio output',
              devices: state.outputs,
              selectedId: choice.outputId,
              empty: 'The browser reported no audio output on this machine.',
              note: routing.sentence,
              disabled: routing.kind === 'none',
              disabledReason: 'This browser cannot route a page\u2019s audio to a chosen output.',
              onSelect: props.onSelectOutput,
            }),
            h(ToneSection, {
              tone: props.tone,
              live: routing.kind !== 'element',
              target: nameOfId(state.outputs, choice.outputId),
              onFrequency: props.onFrequency,
              onLevel: props.onLevel,
              onChannel: props.onChannel,
              onToggle: props.onToggle,
            }),
          ),
          h(
            'div',
            { className: 'dsa-consoleCol' },
            h(DeviceSection, {
              kind: 'input',
              title: 'Audio input',
              devices: state.inputs,
              selectedId: choice.inputId,
              empty: 'The browser reported no audio input on this machine.',
              note:
                state.unnamed === true
                  ? 'The browser hides device names until this page is allowed to capture audio. Press "Show device names" to ask \u2014 the permission is used for nothing else.'
                  : 'Picked for this browser. The live test below opens exactly this device.',
              disabled: false,
              disabledReason: '',
              onSelect: props.onSelectInput,
              head:
                state.unnamed === true
                  ? h(
                      'button',
                      { type: 'button', className: 'dsa-btn', 'data-audio-action': 'names', disabled: props.naming === true, onClick: props.onNames },
                      props.naming === true ? 'Asking\u2026' : 'Show device names',
                    )
                  : null,
            }),
            h(InputTestSection, {
              meter: props.meter,
              sentence: 'A live meter off the chosen input. It is analysed and never played back, so nothing loops.',
              onStart: props.onInputStart,
              onStop: props.onInputStop,
            }),
            h(
              'section',
              { className: 'dsa-devSection', 'data-audio-section': 'engine' },
              h(SectionHead, { title: 'Engine', count: props.engineState }, null),
              h('div', { className: 'dsa-facts' }, h(FactRow, { label: 'sample rate', value: props.engineRate === '' ? 'not running' : props.engineRate })),
            ),
          ),
        ),
      )
    }

    /**
     * The console, stateful half: enumerate, remember, route, play, listen.
     *
     * @param props - `{ close }` from the dialog, or from the seat when there is
     *   no dialog to close.
     */
    function AudioConsole(props) {
      const close = props !== null && props !== undefined && typeof props.close === 'function' ? props.close : () => {}
      const [state, setState] = useState({ phase: 'loading', error: '', unnamed: false, outputs: [], inputs: [] })
      const [choice, setChoice] = useState(() => readChoice(storageNow()))
      const [tone, setTone] = useState({ playing: false, frequency: TONE_DEFAULT_HZ, level: TONE_LEVEL_DEFAULT, channel: 'both' })
      const [meter, setMeter] = useState({ phase: 'idle', error: '', level: 0, peak: 0, rows: [] })
      const [status, setStatus] = useState(null)
      const [naming, setNaming] = useState(false)
      const [engine, setEngine] = useState({ state: 'not started', rate: '' })
      const routing = useMemo(() => outputStrategyNow(), [])
      // Refs mirror the two pieces of state a callback needs without becoming a
      // dependency of it: a callback that re-created itself on every slider step
      // would rebuild the tone's own handlers under the running tone.
      const choiceRef = useRef(choice)
      const toneSettings = useRef({ frequency: TONE_DEFAULT_HZ, level: TONE_LEVEL_DEFAULT, channel: 'both' })
      const toneRef = useRef(null)
      const toneToken = useRef(0)
      const streamRef = useRef(null)
      const frameRef = useRef(0)
      choiceRef.current = choice
      toneSettings.current = { frequency: tone.frequency, level: tone.level, channel: tone.channel }

      const refresh = useCallback(async () => {
        const result = await enumerateNow()
        if (result.ok !== true) {
          setState({ phase: 'error', error: result.message, unnamed: false, outputs: [], inputs: [] })
          return
        }
        setState({ phase: 'ready', error: '', unnamed: result.unnamed, outputs: result.outputs, inputs: result.inputs })
      }, [])

      /**
       * The engine's own state, so a person can tell "no sound because the
       * context is suspended" from "no sound because the output is wrong" - the
       * first question anyone asks a silent page.
       *
       * It reads the context this package ALREADY has and never creates one:
       * opening an audio device to fill in a table row would light up the
       * machine's audio session the moment the console is opened.
       */
      const refreshEngine = useCallback(() => {
        const context = audioContext
        if (context === null) {
          setEngine({ state: 'not started', rate: '' })
          return
        }
        setEngine({
          state: typeof context.state === 'string' ? context.state : 'unknown',
          rate: typeof context.sampleRate === 'number' && context.sampleRate > 0 ? context.sampleRate + ' Hz' : '',
        })
      }, [])

      // The list, and every change the MACHINE makes to it.
      useEffect(() => {
        refresh()
      }, [refresh])
      useEffect(() => subscribeDeviceChange(refresh), [refresh])

      // What the service answers, so another bundle sees the same list the
      // console does rather than a second enumeration of its own.
      useEffect(() => {
        publishSeen({
          phase: state.phase,
          strategy: routing.kind,
          outputId: choice.outputId,
          inputId: choice.inputId,
          outputs: state.outputs,
          inputs: state.inputs,
          unnamed: state.unnamed,
        })
      }, [state, choice, routing.kind])

      // The pick is applied where the page can apply it, and a refusal is said
      // OUT LOUD instead of leaving a person to wonder why nothing moved.
      useEffect(() => {
        if (routing.kind === 'none') return undefined
        let live = true
        applySinkEverywhere(choice.outputId).then((failures) => {
          if (live && failures.length > 0) setStatus({ tone: 'error', message: failures[0] })
        })
        return () => {
          live = false
        }
      }, [choice.outputId, routing.kind])

      const selectOutput = useCallback((id) => {
        const next = { outputId: id, inputId: choiceRef.current.inputId }
        choiceRef.current = next
        sessionOutputId = id
        writeChoice(storageNow(), next)
        setChoice(next)
        setStatus(null)
      }, [])

      const selectInput = useCallback((id) => {
        const next = { outputId: choiceRef.current.outputId, inputId: id }
        choiceRef.current = next
        writeChoice(storageNow(), next)
        setChoice(next)
        setStatus(null)
      }, [])

      const stopTone = useCallback(() => {
        const handle = toneRef.current
        toneRef.current = null
        toneToken.current += 1
        if (handle !== null && handle !== undefined) handle.stop()
        setTone((previous) => (previous.playing ? { ...previous, playing: false } : previous))
      }, [])

      const playTone = useCallback(() => {
        const previous = toneRef.current
        if (previous !== null && previous !== undefined) previous.stop()
        toneRef.current = null
        toneToken.current += 1
        const token = toneToken.current
        const settings = toneSettings.current
        // The status line is for what went WRONG (and for the one confirmation a
        // permission earns): starting a tone is not news, so nothing is said.
        setStatus(null)
        const started = startTone({
          strategy: routing.kind,
          frequency: settings.frequency,
          level: settings.level,
          channel: settings.channel,
          onEnded: () => {
            if (toneToken.current !== token) return
            toneRef.current = null
            setTone((value) => (value.playing ? { ...value, playing: false } : value))
          },
          onError: (message) => {
            if (toneToken.current !== token) return
            setStatus({ tone: 'error', message: message })
          },
        })
        if (started.ok !== true) {
          setTone((value) => (value.playing ? { ...value, playing: false } : value))
          setStatus({ tone: 'error', message: started.message })
          return
        }
        toneRef.current = started.handle
        setTone((value) => ({ ...value, playing: true }))
        refreshEngine()
      }, [refreshEngine, routing.kind])

      const toggleTone = useCallback(() => {
        if (toneRef.current !== null && toneRef.current !== undefined) {
          stopTone()
          return
        }
        playTone()
      }, [playTone, stopTone])

      const stopCapture = useCallback(() => {
        if (frameRef.current !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
        const stream = streamRef.current
        streamRef.current = null
        if (stream !== null && stream !== undefined && typeof stream.getTracks === 'function') {
          for (const track of stream.getTracks()) {
            try {
              track.stop()
            } catch (err) {
              /* already stopped */
            }
          }
        }
        setMeter((previous) => (previous.phase === 'idle' ? previous : { phase: 'idle', error: '', level: 0, peak: 0, rows: [] }))
      }, [])

      const startCapture = useCallback(async () => {
        const devices = mediaDevicesNow()
        if (devices === null) {
          setMeter({ phase: 'error', error: 'This page is not a secure context, so the browser will not open a microphone for it.', level: 0, peak: 0, rows: [] })
          return
        }
        setMeter({ phase: 'starting', error: '', level: 0, peak: 0, rows: [] })
        let stream = null
        try {
          stream = await devices.getUserMedia(captureConstraints(choiceRef.current.inputId))
        } catch (err) {
          setMeter({ phase: 'error', error: 'The microphone could not be opened: ' + messageOf(err), level: 0, peak: 0, rows: [] })
          return
        }
        const track = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks()[0] : null
        streamRef.current = stream
        let analyser = null
        try {
          const context = audioContextNow()
          if (typeof context.resume === 'function') context.resume()
          const source = context.createMediaStreamSource(stream)
          analyser = context.createAnalyser()
          analyser.fftSize = METER_FFT
          // A SINK: nothing here is ever connected to the context's destination,
          // which is what keeps the meter from feeding the room back into it.
          source.connect(analyser)
        } catch (err) {
          analyser = null
        }
        setMeter({
          phase: 'live',
          error: analyser === null ? 'The browser opened the microphone, but this page has no audio engine to analyse it with.' : '',
          level: 0,
          peak: 0,
          rows: describeStream(track),
        })
        // Opening the microphone is also what REVEALS the device names, so the
        // list is asked again - a person who granted the permission should not
        // have to press Reload to see what they got.
        refresh()
        refreshEngine()
        if (analyser === null) return
        const data = new Uint8Array(analyser.fftSize)
        let last = 0
        const tick = (time) => {
          if (streamRef.current === null) return
          if (time - last >= METER_INTERVAL_MS) {
            last = time
            try {
              analyser.getByteTimeDomainData(data)
            } catch (err) {
              /* the stream went away between frames */
            }
            const level = rmsOfWaveform(data)
            setMeter((previous) => (previous.phase === 'live' ? { ...previous, level: level, peak: Math.max(previous.peak, level) } : previous))
          }
          frameRef.current = window.requestAnimationFrame(tick)
        }
        frameRef.current = window.requestAnimationFrame(tick)
      }, [refresh, refreshEngine])

      const askForNames = useCallback(async () => {
        const devices = mediaDevicesNow()
        if (devices === null) {
          setStatus({ tone: 'error', message: 'This page is not a secure context, so the browser exposes no device list at all.' })
          return
        }
        setNaming(true)
        setStatus(null)
        let refused = ''
        try {
          const stream = await devices.getUserMedia({ audio: true })
          if (stream !== null && stream !== undefined && typeof stream.getTracks === 'function') {
            for (const track of stream.getTracks()) {
              try {
                track.stop()
              } catch (err) {
                /* already stopped */
              }
            }
          }
        } catch (err) {
          refused = messageOf(err)
        }
        setNaming(false)
        await refresh()
        setStatus(
          refused === ''
            ? { tone: 'ok', message: 'The device names are visible now.' }
            : { tone: 'error', message: 'The browser refused: ' + refused },
        )
      }, [refresh])

      // A console that goes away takes its sound and its microphone with it.
      useEffect(
        () => () => {
          const handle = toneRef.current
          toneRef.current = null
          if (handle !== null && handle !== undefined) handle.stop()
          stopCapture()
        },
        [stopCapture],
      )

      // The chosen output is applied to the app's audio engine as soon as the
      // console opens, so a context that was created BEFORE the last choice (or
      // after a reload) is brought back to it.
      useEffect(() => {
        refreshEngine()
      }, [refreshEngine])

      return h(AudioConsoleView, {
        state: state,
        choice: choice,
        routing: routing,
        tone: tone,
        meter: meter,
        status: status,
        naming: naming,
        engineState: engine.state,
        engineRate: engine.rate,
        onSelectOutput: selectOutput,
        onSelectInput: selectInput,
        onFrequency: useCallback((value) => setTone((previous) => ({ ...previous, frequency: clampFrequency(value) })), []),
        onLevel: useCallback((value) => setTone((previous) => ({ ...previous, level: Math.max(0, Math.min(100, Math.round(Number(value) || 0))) })), []),
        onChannel: useCallback((value) => setTone((previous) => ({ ...previous, channel: value === 'left' || value === 'right' ? value : 'both' })), []),
        onToggle: toggleTone,
        onInputStart: startCapture,
        onInputStop: stopCapture,
        onNames: askForNames,
        onReload: refresh,
        onClose: () => close(null),
      })
    }

    /**
     * The panel the person was on before this one.
     *
     * See `AudioPanelRow` for why this is WATCHED rather than read at mount.
     */
    let panelBeforeAudio = null

    /** Start (and stop) the watcher over `layout`'s panel selection. */
    function watchPanels() {
      const ctx = pluginCtx
      if (ctx === null || typeof ctx.get !== 'function') return () => {}
      let info = null
      try {
        const layout = ctx.get('layout')
        info = layout === null || layout === undefined ? null : layout.panelInfo
      } catch (err) {
        info = null
      }
      if (info === null || info === undefined || typeof info.getSnapshot !== 'function' || typeof info.subscribe !== 'function') return () => {}
      const read = () => {
        let active = null
        try {
          const snapshot = info.getSnapshot()
          active = snapshot === null || snapshot === undefined ? null : snapshot.activePanelId
        } catch (err) {
          active = null
        }
        if (typeof active === 'string' && active !== '' && active !== PANEL_ID) panelBeforeAudio = active
      }
      read()
      const off = info.subscribe(read)
      return typeof off === 'function' ? off : () => {}
    }

    /**
     * Hand the central column back to the panel the person came from.
     *
     * The guard is the point: if they have since moved to ANOTHER panel, that is
     * their choice and this leaves it alone - only a column still showing this
     * package's own seat is handed back.
     */
    function restorePanel() {
      const ctx = pluginCtx
      if (ctx === null || typeof ctx.get !== 'function') return
      let layout = null
      try {
        layout = ctx.get('layout')
      } catch (err) {
        layout = null
      }
      if (layout === null || layout === undefined || typeof layout.selectPanel !== 'function') return
      let active = null
      try {
        const info = layout.panelInfo
        const snapshot = info !== null && info !== undefined && typeof info.getSnapshot === 'function' ? info.getSnapshot() : null
        active = snapshot === null || snapshot === undefined ? null : snapshot.activePanelId
      } catch (err) {
        active = null
      }
      if (active !== PANEL_ID) return
      try {
        layout.selectPanel(panelBeforeAudio)
      } catch (err) {
        // The panel this came from is gone (a plugin was unloaded): the
        // Conversation is the answer that always exists.
        try {
          layout.selectPanel(null)
        } catch (inner) {
          /* nothing to hand back to */
        }
      }
    }

    /**
     * The main column's seat: the panel the sidebar row selects, and the only
     * door to the console.
     *
     * The dialog is opened ON MOUNT, which is what makes the left-bar row behave
     * like a modal button. The seat underneath is not a dead end either: it
     * carries its own "Open the console" control, so a dialog dismissed without
     * the column being handed back can always be reopened.
     */
    function AudioSeat(props) {
      const inline = props !== null && props !== undefined && props.inline === true
      const modals = serviceNow(MODAL_SERVICE)
      const hasModal = inline !== true && modals !== null && modals !== undefined && typeof modals.open === 'function'
      const [version, setVersion] = useState(0)
      // The service goes in a REF rather than in the effect's dependencies.
      // `version` is what re-opens the dialog, and a service whose identity
      // changed between renders (a provider that answers a fresh wrapper) would
      // make this effect re-open the dialog on EVERY render - a queue of dialogs
      // from a button that was pressed once.
      const modalsRef = useRef(modals)
      modalsRef.current = modals
      useEffect(() => {
        const service = modalsRef.current
        if (!hasModal || service === null) return undefined
        let live = true
        let pending = null
        try {
          pending = service.open({ title: '', size: 'lg', content: (helpers) => h(AudioConsole, { close: helpers.close }) })
        } catch (err) {
          restorePanel()
          return undefined
        }
        if (pending !== null && pending !== undefined && typeof pending.then === 'function') {
          pending.then(
            () => {
              if (live) restorePanel()
            },
            () => {
              if (live) restorePanel()
            },
          )
        }
        return () => {
          live = false
        }
      }, [hasModal, version])
      if (!hasModal) {
        return h('div', { className: 'dsa-seat', 'data-audio-seat': 'inline' }, h(AudioConsole, { close: () => restorePanel() }))
      }
      return h(
        'div',
        { className: 'dsa-seat', 'data-audio-seat': 'dialog' },
        h(
          'div',
          { className: 'dsa-state' },
          h('div', { className: 'dsa-stateTitle' }, 'The audio console opens in a dialog'),
          h('div', { className: 'dsa-stateNote' }, 'Devices, the output this page plays through, and a tone that proves it.'),
          h('button', { type: 'button', className: 'dsa-btn', 'data-audio-action': 'open-console', onClick: () => setVersion((value) => value + 1) }, 'Open the console'),
        ),
      )
    }

    // =====================================================================
    // 14. The tab body
    // =====================================================================
    /** Which decoder a path will take, for the loading sentence. */
    function decoderLabel(path) {
      return extensionOf(path) === 'flac' ? 'the browser' : 'this package'
    }

    /** The `audio` tab: one file, from its bytes to a waveform. */
    function AudioBody(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      const address = tab && typeof tab.contentId === 'string' ? tab.contentId : ''
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [reload, setReload] = useState(0)
      const parsed = useMemo(() => parseAudioAddress(address), [address])
      const source = useAudioSource(address, sessionId, reload)
      const name = baseNameOf(address)
      const scopeLabel = parsed ? (parsed.sessionId === '' ? parsed.path : parsed.sessionId + '/' + parsed.path) : address
      const again = useCallback(() => setReload((count) => count + 1), [])

      if (source.phase === 'loading') {
        return h(
          'div',
          { className: 'dsa-root' },
          h(
            'div',
            { className: 'dsa-state', 'data-audio-state': 'loading' },
            h('div', { className: 'dsa-stateTitle' }, 'Opening ' + name + '\u2026'),
            h('div', { className: 'dsa-stateNote' }, source.stage === 'decoding' ? 'Decoding with ' + decoderLabel(parsed ? parsed.path : '') + ' \u2014 ' + source.progress + '%' : 'Reading the header\u2026'),
            h('div', { className: 'dsa-stateNote' }, scopeLabel),
          ),
        )
      }
      if (source.phase === 'failed') {
        return h(
          StateBox,
          { state: 'error', title: name + ' could not be opened', error: source.error, note: scopeLabel },
          h('button', { type: 'button', className: 'dsa-btn', 'data-audio-action': 'retry', onClick: again }, 'Try again'),
        )
      }
      if (source.peaks === null) {
        // A FLAC past the single-read cap: its facts are exact (STREAMINFO is
        // in the first bytes) and the waveform is what cannot be drawn.
        return h(
          'div',
          { className: 'dsa-root' },
          h(
            StateBox,
            {
              state: 'refused',
              title: name + ' is a ' + (source.facts.container === undefined ? 'compressed' : source.facts.container) + ' this viewer states but cannot draw',
              error: source.refusal,
              note:
                source.facts.sampleRate +
                ' Hz \u00b7 ' +
                source.facts.channels +
                ' ch \u00b7 ' +
                (source.facts.bits > 0 ? source.facts.bits + '-bit \u00b7 ' : '') +
                formatTime(source.facts.duration) +
                ' \u00b7 ' +
                humanBytes(source.size) +
                ' (' +
                scopeLabel +
                ')',
            },
            h('button', { type: 'button', className: 'dsa-btn', 'data-audio-action': 'retry', onClick: again }, 'Try again'),
          ),
        )
      }
      return h(AudioViewer, {
        // A re-read is a NEW viewer: the playback buffer, the zoom, the
        // selection and the playhead all belong to the load, not to the path.
        key: 'dsh-audio-load-' + reload,
        facts: source.facts,
        peaks: source.peaks,
        samples: source.samples === undefined ? null : source.samples,
        buffer: source.buffer === undefined ? null : source.buffer,
        size: source.size,
        source: source.source,
        name: name,
        path: parsed ? parsed.path : name,
        onReload: again,
      })
    }

    /** The chip title: the file's own name. */
    function AudioTitle(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      return h('span', { className: 'dsa-title' }, baseNameOf(tab ? tab.contentId : ''))
    }

    // =====================================================================
    // 15. The tab type
    // =====================================================================
    /**
     * The `audio` type: an `extension`-band type for the audio suffixes, which
     * outranks the shipped preview's `fallback` type for the same address and
     * leaves every other file type untouched. `canOpen` is what keeps a
     * non-audio address out of this tab even if a pattern ever matched one.
     *
     * There is deliberately no `guide` entry: a blank audio file is not a
     * document anyone opens from the "+" control, so this type only ever claims
     * a real file address.
     */
    function audioDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        patterns: Object.keys(MEDIA_TYPES).map((extension) => '*.' + extension),
        priority: 'extension',
        canOpen: (address) => isAudioAddress(address),
        title: (address) => baseNameOf(address),
      }
    }

    // =====================================================================
    // 16. Plugin entry
    // =====================================================================
    /** Services activation waits for: the seats, the tab registry, and the bytes. */
    const inject = ['slots', 'sidebarRightTabs', REMOTE_NAMESPACE]

    /**
     * Activate the browser half.
     *
     * `layout` and `modals` are NOT in `inject` on purpose: this package's tab is
     * its primary surface and must keep working in a profile that installed it
     * without the pack's dialog bundle, so both are resolved through `ctx.get`
     * where they are used - the seat degrades to an inline page without one, and
     * the row degrades to a plain panel without the other.
     *
     * @param ctx - cordis context (inject: slots, sidebarRightTabs,
     *   remote.workspaceFiles).
     */
    function apply(ctx) {
      pluginCtx = ctx
      try {
        workspaceFiles = ctx && typeof ctx.get === 'function' ? ctx.get(REMOTE_NAMESPACE) : null
      } catch (err) {
        workspaceFiles = null
      }
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(audioDefinition()), 'dsh-audio: audio tab type')
        ctx.effect(
          () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, AudioBody)),
          'dsh-audio: audio tab body',
        )
        ctx.effect(
          () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, AudioTitle)),
          'dsh-audio: audio tab title',
        )
        // The left column's row, ONE ABOVE Plugins, and the seat its click needs.
        ctx.effect(
          () => ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, id: PANEL_ID, order: PANEL_ORDER, label: 'Audio', inject: () => ({}) }, AudioPanelRow)),
          'dsh-audio: the left column row',
        )
        ctx.effect(
          () => ctx.slots.inject(MAIN_SLOT, () => ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID, inject: () => ({}) }, AudioSeat)),
          'dsh-audio: the panel seat',
        )
        // Every media element the page starts joins the chosen output, whether or
        // not the console has been opened in this session.
        ctx.effect(() => watchMediaElements(), 'dsh-audio: media elements follow the chosen output')
        // The service is the one thing here that needs `reflect`, and a context
        // without it still gets the row, the seat and the tab: the publish is
        // skipped rather than taking the whole activation down with it.
        const reflect = ctx.reflect
        if (reflect !== null && reflect !== undefined && typeof reflect.provide === 'function') {
          ctx.effect(
            () => {
              const dispose = reflect.provide(SERVICE_NAME, audioDevicesFace())
              return () => {
                if (typeof dispose === 'function') dispose()
                seenListeners.clear()
              }
            },
            'dsh-audio: audioDevices service',
          )
        }
        ctx.logger?.debug?.('[dsh-audio] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-audio] activation failed', err)
        ctx.logger?.warn?.('[dsh-audio] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-audio'
    exports.inject = inject
    exports.apply = apply
    /**
     * The PURE half, for the tracked check (scripts/checks/check-client-bundles.mjs):
     * the container parsers, the PCM decoder, the peak pyramid and the ruler math
     * take bytes and return numbers, with no DOM, no Remote and no React in
     * sight - so the check can build a WAV/AIFF/FLAC in memory and assert what
     * they decode to, which is the only way a browser-only bundle's arithmetic
     * gets verified at all.
     *
     * Section 13's half is the same bargain: the device list, the output strategy
     * for each browser shape, the tone's numbers, the WAV ENCODER behind the
     * `element` path and the meter's arithmetic are all pure, and the console
     * itself is exported as its presentational half so a render can assert the
     * cards, the marks and the sentences. NOT part of the plugin's contract:
     * nothing in the app reads it, and it exists so the numbers cannot quietly
     * drift.
     */
    exports.__internals = {
      BASE_BUCKET: BASE_BUCKET,
      LEVEL_FACTOR: LEVEL_FACTOR,
      MIN_PPS: MIN_PPS,
      MAX_PPS: MAX_PPS,
      MEDIA_TYPES: MEDIA_TYPES,
      decodeBase64: decodeBase64,
      bytesOf: bytesOf,
      parseWav: parseWav,
      parseAiff: parseAiff,
      parseFlacInfo: parseFlacInfo,
      parseContainer: parseContainer,
      decodePcm: decodePcm,
      PeakSet: PeakSet,
      peaksFromAudioBuffer: peaksFromAudioBuffer,
      decimateLevel: decimateLevel,
      pickLevel: pickLevel,
      columnEnvelope: columnEnvelope,
      withAlpha: withAlpha,
      tickStepFor: tickStepFor,
      tickDecimals: tickDecimals,
      formatTime: formatTime,
      formatDb: formatDb,
      amplitudeToDb: amplitudeToDb,
      channelLabel: channelLabel,
      alawToLinear: alawToLinear,
      ulawToLinear: ulawToLinear,
      parseAudioAddress: parseAudioAddress,
      isAudioAddress: isAudioAddress,
      baseNameOf: baseNameOf,
      AudioViewer: AudioViewer,
      InfoPanel: InfoPanel,
      // --- the audio console (section 13)
      PANEL_SLOT: PANEL_SLOT,
      MAIN_SLOT: MAIN_SLOT,
      PANEL_ID: PANEL_ID,
      PANEL_ORDER: PANEL_ORDER,
      STORAGE_KEY: STORAGE_KEY,
      TONE_MAX_SECONDS: TONE_MAX_SECONDS,
      normalizeDevices: normalizeDevices,
      deviceTitle: deviceTitle,
      shortId: shortId,
      defaultTargetOf: defaultTargetOf,
      nameOfId: nameOfId,
      pickOutputStrategy: pickOutputStrategy,
      outputStrategyNow: outputStrategyNow,
      startTone: startTone,
      gainForLevel: gainForLevel,
      dbForLevel: dbForLevel,
      clampFrequency: clampFrequency,
      panForChannel: panForChannel,
      toneChannels: toneChannels,
      encodeWav: encodeWav,
      rmsOfWaveform: rmsOfWaveform,
      levelBar: levelBar,
      camelWords: camelWords,
      describeStream: describeStream,
      captureConstraints: captureConstraints,
      readChoice: readChoice,
      writeChoice: writeChoice,
      AudioConsoleView: AudioConsoleView,
      AudioConsole: AudioConsole,
      DeviceSection: DeviceSection,
      ToneSection: ToneSection,
      InputTestSection: InputTestSection,
      AudioPanelRow: AudioPanelRow,
      AudioSeat: AudioSeat,
    }
    return module.exports
  },
})
