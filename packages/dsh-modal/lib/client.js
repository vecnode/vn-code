/**
 * dsh-modal - browser half.
 *
 * The pack's shared dialog surface: a body-level overlay any client plugin of
 * this pack (or any deployment plugin) reaches through the client service
 *
 *     const modals = ctx.get('modals')
 *     await modals.open({ title, message, fields, validate, submit })
 *
 * so a plugin never ships its own prompt markup and every dialog in the app
 * looks and behaves the same:
 *
 *   - `modals.open(spec)` answers a Promise: `null` when the dialog is
 *     cancelled, otherwise the field values (or whatever `spec.submit`
 *     returned);
 *   - `spec.submit(values)` runs WHILE the dialog stays open, so the work that
 *     can fail - a save, a rename, a request - reports its failure inline and
 *     the user keeps what they typed instead of losing the dialog;
 *   - `modals.alert(...)` / `modals.confirm(...)` / `modals.prompt(...)` are
 *     the three shapes that cover almost every call site.
 *
 * ONE dialog shows at a time: a second request queues behind the first and
 * opens when it settles, so two racing saves can never clobber each other.
 * Cancel paths are the Cancel button, Escape (captured before the app's own
 * handlers, so the dialog closes and the pane under it does not), and a click
 * on the mask; none of them fires while `spec.submit` is still running.
 *
 * A RICH DIALOG is the same surface with `content` (alpha.2): a render function
 * that receives `{ close }` and owns the whole body, for a dialog that is not a
 * question - a list beside a document, a browser, a form of its own. Fields,
 * `validate` and `submit` do not apply to one (the content drives its own work),
 * the panel grows to `size: 'lg'`, and a MASK CLICK NO LONGER CLOSES IT: a rich
 * dialog can hold half-finished work, and a stray click outside it must not
 * throw that away - Escape and the content's own Close button remain.
 *
 * The host owns no slot: it creates its own detached container on
 * `document.body` and renders it with `react-dom/client`'s `createRoot`, both
 * of which the shell seeds in the module table (`react`, `react-dom`,
 * `react-dom/client`). That is what makes the surface usable from every
 * plugin without asking any of them to render it.
 *
 * Module-table format of every core client package; no build step.
 */
/* global window, document */
window.__ModuleLoader__.load({
  id: 'dsh-modal',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOMClient = require('react-dom/client')
    const h = React.createElement

    /** Version marker, mirrored by the package manifest. */
    const PLUGIN_VERSION = '0.1.0-alpha.2'
    /** The client service name other plugins resolve. */
    const SERVICE = 'modals'

    // ---------------------------------------------------------------------
    // Styles (dark/light neutral: every color comes from a design token, with a
    // plain fallback so the dialog is legible even outside the product shell).
    // ---------------------------------------------------------------------
    const css = `
.dsm-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.dsm-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42));backdrop-filter:var(--dsw-mask-blur,blur(2px))}
.dsm-panel{position:relative;z-index:1;box-sizing:border-box;width:420px;max-width:100%;max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-2,#242424);color:var(--dsw-alias-label-primary,#ececec);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.4));font-family:var(--dsw-font-family,inherit);font-size:13.5px;line-height:1.55}
.dsm-title{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#ececec)}
/* A rich dialog (spec.content) owns its whole body: the panel is a frame that
   the content lays out, so it stops padding and scrolling itself. */
.dsm-panel.dsm-lg{width:min(1120px,94vw);height:min(800px,90vh);padding:0;gap:0;overflow:hidden}
.dsm-content{flex:1;min-height:0;display:flex;flex-direction:column}
.dsm-message{margin:0;color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:12.5px;line-height:1.55;overflow-wrap:anywhere}
.dsm-form{display:flex;flex-direction:column;gap:12px;margin:0}
.dsm-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsm-label{font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-primary,#ececec);font:inherit;font-size:13px;outline:none}
.dsm-input.dsm-mono{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12.5px}
.dsm-input:focus{border-color:var(--dsw-alias-state-accent,#4f8cff)}
.dsm-input:disabled{opacity:.6}
.dsm-hint{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsm-error{margin:0;font-size:12px;line-height:1.45;color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px}
.dsm-button{box-sizing:border-box;height:30px;padding:0 14px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,#ececec);font:inherit;font-size:12.5px;cursor:pointer}
.dsm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-button:disabled{opacity:.5;cursor:default}
.dsm-button.dsm-primary{border-color:transparent;background:var(--dsw-alias-state-accent,#4f8cff);color:#fff;font-weight:500}
.dsm-button.dsm-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-state-accent,#4f8cff)}
.dsm-button.dsm-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary,#e5534b);color:#fff;font-weight:500}
`
    const CSS_TAG = 'dsh-modal/modal.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-modal'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // The dialog queue. One visible at a time, first come first served, so two
    // racing callers never replace each other's dialog.
    // ---------------------------------------------------------------------
    let nextId = 0
    const queue = []
    let current = null
    const listeners = new Set()

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (e) {
          /* a throwing subscriber must not break the others */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function getSnapshot() {
      return current
    }

    function pump() {
      if (current !== null || queue.length === 0) return
      current = queue.shift()
      notify()
    }

    /** Settle one request exactly once and let the next queued dialog open. */
    function finish(request, result) {
      if (current !== null && current.id === request.id) {
        current = null
        notify()
      } else {
        const at = queue.indexOf(request)
        if (at >= 0) queue.splice(at, 1)
      }
      request.resolve(result)
      pump()
    }

    /** A readable message for anything a caller's `submit` can throw. */
    function messageOf(error) {
      if (error === null || error === undefined) return 'Something went wrong.'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function normalizeField(field, index) {
      const source = field && typeof field === 'object' ? field : {}
      return {
        name: typeof source.name === 'string' && source.name !== '' ? source.name : 'field' + String(index + 1),
        label: typeof source.label === 'string' ? source.label : '',
        value: typeof source.value === 'string' ? source.value : '',
        placeholder: typeof source.placeholder === 'string' ? source.placeholder : '',
        hint: typeof source.hint === 'string' ? source.hint : '',
        mono: source.mono === true,
        required: source.required === true,
        maxLength: typeof source.maxLength === 'number' && source.maxLength > 0 ? source.maxLength : 400,
      }
    }

    /** Complete one caller's spec; `null` results stay the cancel signal. */
    function normalizeSpec(spec, resolve) {
      const source = spec && typeof spec === 'object' ? spec : {}
      nextId += 1
      return {
        id: nextId,
        title: typeof source.title === 'string' ? source.title : '',
        message: typeof source.message === 'string' ? source.message : '',
        fields: Array.isArray(source.fields) ? source.fields.map(normalizeField) : [],
        validate: typeof source.validate === 'function' ? source.validate : undefined,
        submit: typeof source.submit === 'function' ? source.submit : undefined,
        /** A rich dialog's own body; when present it replaces fields and actions. */
        content: typeof source.content === 'function' ? source.content : undefined,
        /** `size: 'lg'` is the roomy frame a two-column rich dialog is laid out in. */
        size: source.size === 'lg' ? 'lg' : 'md',
        confirmLabel: typeof source.confirmLabel === 'string' && source.confirmLabel !== '' ? source.confirmLabel : 'OK',
        /** `cancelLabel: null` renders no cancel button (a plain acknowledgement). */
        cancelLabel: source.cancelLabel === null ? null : typeof source.cancelLabel === 'string' && source.cancelLabel !== '' ? source.cancelLabel : 'Cancel',
        busyLabel: typeof source.busyLabel === 'string' && source.busyLabel !== '' ? source.busyLabel : 'Working\u2026',
        danger: source.danger === true,
        resolve,
      }
    }

    function specOf(spec) {
      return typeof spec === 'string' ? { message: spec } : spec && typeof spec === 'object' ? spec : {}
    }

    // ---------------------------------------------------------------------
    // The public service face.
    // ---------------------------------------------------------------------
    /**
     * Open one dialog.
     * @param spec - `{ title?, message?, fields?, validate?, submit?, confirmLabel?, cancelLabel?, busyLabel?, danger? }`.
     * @returns `null` when cancelled, else the field values (or `submit`'s return value).
     */
    function open(spec) {
      return new Promise((resolve) => {
        queue.push(normalizeSpec(spec, resolve))
        pump()
      })
    }

    /** Acknowledge one message: a title, a body, and a single confirm button. */
    async function alert(spec) {
      const base = specOf(spec)
      await open({
        ...base,
        cancelLabel: null,
        confirmLabel: typeof base.confirmLabel === 'string' ? base.confirmLabel : 'OK',
      })
    }

    /** Ask a yes/no question; `true` only when the confirm button was used. */
    async function confirm(spec) {
      const base = specOf(spec)
      const values = await open({
        ...base,
        confirmLabel: typeof base.confirmLabel === 'string' ? base.confirmLabel : 'OK',
      })
      return values !== null
    }

    /** Ask for one line of text; `null` when cancelled. */
    async function prompt(spec) {
      const base = specOf(spec)
      const values = await open({
        ...base,
        title: typeof base.title === 'string' ? base.title : 'Enter a value',
        fields: [
          {
            name: 'value',
            label: typeof base.label === 'string' ? base.label : '',
            value: typeof base.value === 'string' ? base.value : '',
            placeholder: typeof base.placeholder === 'string' ? base.placeholder : '',
            hint: typeof base.hint === 'string' ? base.hint : '',
            mono: base.mono === true,
            required: base.required === true,
          },
        ],
      })
      return values === null ? null : String(values.value === undefined ? '' : values.value)
    }

    /** Close whatever is open, resolving it with `result` (default `null`). */
    function close(result) {
      if (current === null) return
      finish(current, result === undefined ? null : result)
    }

    function isOpen() {
      return current !== null
    }

    // ---------------------------------------------------------------------
    // The overlay.
    // ---------------------------------------------------------------------
    function initialValues(request) {
      const values = {}
      for (const field of request.fields) values[field.name] = field.value
      return values
    }

    /** One dialog, keyed by request id so each request starts from its own values. */
    function Dialog({ request }) {
      const [values, setValues] = React.useState(() => initialValues(request))
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const busyRef = React.useRef(false)
      const firstRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      const titleId = React.useId()

      // Focus the first field (or the panel) on open and hand focus back to
      // whatever had it when the dialog closes.
      React.useEffect(() => {
        restoreRef.current = document.activeElement
        const node = firstRef.current || panelRef.current
        if (node && typeof node.focus === 'function') {
          try {
            node.focus()
            if (typeof node.select === 'function') node.select()
          } catch (e) {}
        }
        return () => {
          const previous = restoreRef.current
          if (previous && previous !== document.body && typeof previous.focus === 'function' && document.contains(previous)) {
            try {
              previous.focus()
            } catch (e) {}
          }
        }
      }, [])

      const cancel = React.useCallback(() => {
        if (busyRef.current) return
        finish(request, null)
      }, [request])

      // Escape belongs to the dialog while it is up: captured on the document
      // so the pane underneath never sees the key.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [cancel])

      const submit = React.useCallback(async () => {
        if (busyRef.current) return
        const missing = request.fields.find((field) => field.required && String(values[field.name] === undefined ? '' : values[field.name]).trim() === '')
        if (missing !== undefined) {
          setError((missing.label !== '' ? missing.label : missing.name) + ' is required.')
          return
        }
        if (request.validate !== undefined) {
          let verdict
          try {
            verdict = request.validate(values)
          } catch (e) {
            setError(messageOf(e))
            return
          }
          if (typeof verdict === 'string' && verdict !== '') {
            setError(verdict)
            return
          }
        }
        if (request.submit === undefined) {
          finish(request, values)
          return
        }
        busyRef.current = true
        setBusy(true)
        setError('')
        let result
        try {
          result = await request.submit(values)
        } catch (e) {
          busyRef.current = false
          setBusy(false)
          setError(messageOf(e))
          return
        }
        busyRef.current = false
        setBusy(false)
        finish(request, result === undefined ? values : result)
      }, [request, values])

      const rows = request.fields.map((field, index) =>
        h(
          'label',
          { className: 'dsm-field', key: field.name },
          field.label === '' ? null : h('span', { className: 'dsm-label' }, field.label),
          h('input', {
            ref: index === 0 ? firstRef : undefined,
            className: 'dsm-input' + (field.mono ? ' dsm-mono' : ''),
            type: 'text',
            value: values[field.name] === undefined ? '' : values[field.name],
            placeholder: field.placeholder,
            'aria-label': field.label === '' ? field.name : undefined,
            spellCheck: false,
            autoComplete: 'off',
            disabled: busy,
            maxLength: field.maxLength,
            onChange: (event) => {
              const next = event.target.value
              setValues((previous) => ({ ...previous, [field.name]: next }))
            },
          }),
          field.hint === '' ? null : h('span', { className: 'dsm-hint' }, field.hint),
        ),
      )

      // A RICH DIALOG: the caller's own render function owns the body, so there
      // is no form, no field row and no action row to submit through - the
      // content closes the dialog itself through the `close` it is handed.
      if (request.content !== undefined) {
        return h(
          'div',
          { className: 'dsm-overlay', role: 'presentation' },
          // No mask click: a rich dialog can hold unsaved work, and Escape (and
          // the content's own Close control) is what closes it.
          h('div', { className: 'dsm-mask', 'aria-hidden': true }),
          h(
            'div',
            {
              ref: panelRef,
              className: 'dsm-panel dsm-lg',
              role: 'dialog',
              'aria-modal': 'true',
              ...(request.title === '' ? { 'aria-label': 'Dialog' } : { 'aria-labelledby': titleId }),
            },
            request.title === '' ? null : h('h2', { className: 'dsm-title', id: titleId }, request.title),
            h('div', { className: 'dsm-content' }, request.content({ close: (result) => finish(request, result === undefined ? null : result) })),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsm-overlay', role: 'presentation' },
        h('div', { className: 'dsm-mask', 'aria-hidden': true, onClick: cancel }),
        h(
          'div',
          {
            ref: panelRef,
            className: 'dsm-panel',
            role: 'dialog',
            'aria-modal': 'true',
            ...(request.title === '' ? { 'aria-label': request.confirmLabel } : { 'aria-labelledby': titleId }),
          },
          request.title === '' ? null : h('h2', { className: 'dsm-title', id: titleId }, request.title),
          request.message === '' ? null : h('p', { className: 'dsm-message' }, request.message),
          h(
            'form',
            {
              className: 'dsm-form',
              onSubmit: (event) => {
                event.preventDefault()
                submit()
              },
            },
            rows,
            error === '' ? null : h('p', { className: 'dsm-error', role: 'alert' }, error),
            h(
              'div',
              { className: 'dsm-actions' },
              request.cancelLabel === null
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-button',
                      disabled: busy,
                      onClick: cancel,
                    },
                    request.cancelLabel,
                  ),
              h(
                'button',
                {
                  type: 'submit',
                  className: 'dsm-button dsm-primary' + (request.danger ? ' dsm-danger' : ''),
                  disabled: busy,
                },
                busy ? request.busyLabel : request.confirmLabel,
              ),
            ),
          ),
        ),
      )
    }

    /** The overlay host: reads the queue's head and renders it (or nothing). */
    function OverlayHost() {
      const request = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      if (request === null) return null
      return h(Dialog, { key: request.id, request })
    }

    /** Create the body-level React root; the returned disposer removes it. */
    function mountHost() {
      if (typeof document === 'undefined' || document.body === null) return () => {}
      const container = document.createElement('div')
      container.dataset.dshModalHost = ''
      document.body.appendChild(container)
      const root = ReactDOMClient.createRoot(container)
      root.render(h(OverlayHost))
      return () => {
        try {
          root.unmount()
        } catch (e) {}
        if (container.parentNode) container.parentNode.removeChild(container)
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** No client service is required: the host owns its own root. */
    const inject = []

    function apply(ctx) {
      try {
        const disposeHost = mountHost()
        const disposeService = ctx.reflect.provide(SERVICE, { open, alert, confirm, prompt, close, isOpen })
        ctx.effect(
          () => () => {
            try {
              disposeService()
            } catch (e) {}
            disposeHost()
          },
          'dsh-modal: overlay host and service',
        )
        ctx.logger?.debug?.('[dsh-modal] overlay host mounted (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-modal] activation failed', err)
        ctx.logger?.warn?.('[dsh-modal] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
