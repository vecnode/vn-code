/**
 * The dock renderer dsh-rightbar splices into its generated fork.
 *
 * This file is a SOURCE FRAGMENT, not a module: `scripts/sync-vendored.ps1`
 * inserts it verbatim (indentation included) into
 * `packages/dsh-rightbar/lib/client.js`, immediately above `intentsFor`, and
 * rewrites the fork's `DockLayout` render into a call to this component. The
 * fork is GENERATED - a hand edit there would be overwritten on the next
 * re-sync - so its one hand-written piece lives here, beside the patch list
 * that puts it in place. The indentation is the fork's own: two tabs are the
 * module factory's top level.
 */
		/**
		 * The dock renderer - the one hand-written component in this generated fork.
		 *
		 * WHY. The kit's `DockLayout` draws a FLAT grid: one pane, or two side by
		 * side, and it THROWS on every other shape ("DockLayout requires one pane or
		 * two horizontally split panes"). This fork lifts the two-pane cap and
		 * re-opens the top/bottom drop bands, so a tab dragged into the upper or
		 * lower quarter of a pane - the drag that builds a 2x2 - planned a COLUMN
		 * split that the very next render refused. The throw reached the shell's slot
		 * boundary, which ABDICATES a crashed entry: the whole right bar disappeared
		 * until a page reload.
		 *
		 * The same kit exports `DockSurface`: the SAME drop-zone host with the
		 * RECURSIVE renderer (`splitRow` / `splitColumn`, a divider per child, one
		 * strip per pane), which draws the tree `planDropTab` and `planSplitPane`
		 * actually build - any depth, four panes included. This renders that, and
		 * keeps the four things the flat renderer provided for free:
		 *
		 *   1. `data-dockkit-host="dock"` on a real box, because the bar's own
		 *      stylesheet hides and slides the docked content through that selector
		 *      (`.P3OORG_panel [data-dockkit-host=dock]`) and the surface renderer
		 *      does not emit it - and `pointer-events: auto`, because that same
		 *      stylesheet turns the PANEL's pointer events OFF (the flat renderer's
		 *      per-tab hosts were what turned them back on, and the surface's panes
		 *      do not: without it the whole bar is deaf to the mouse, measured);
		 *   2. the kit's `FloatLayer`, because the flat renderer drew a floated tab as
		 *      a grid cell while the surface renderer does not draw floats at all;
		 *   3. `active` and `expanded`, which gated every body in the flat renderer -
		 *      an off-screen session's panel, or a collapsed bar, must not mount tabs;
		 *   4. `keepMounted`, so a retained tab (the shipped Browser tab type) stays
		 *      mounted once it has been in front, even while another tab of its pane
		 *      is.
		 *
		 * A kit line without `DockSurface` falls back to the flat renderer - and to
		 * left/right drops only, since that renderer cannot draw a stacked pane.
		 */
		function DockTree(props) {
			const dockkit = _deepseek_ai_dsh_client_ui_dockkit;
			const Surface = dockkit.DockSurface;
			const bodies = props.renderTab;
			const keepMounted = props.keepMounted;
			const state = props.state;
			/** Tabs that have been in front at least once, so a retained one stays mounted. */
			const shown = (0, react.useRef)(new Set());
			/** The pane holding one tab, or null when the layout no longer knows it. */
			const paneOf = (tab) => {
				try {
					return dockkit.findTabPane(state, tab.id);
				} catch (err) {
					return null;
				}
			};
			/**
			 * One pane body: the tab in front, plus the retained tabs of its pane that
			 * have been shown before, kept mounted behind it.
			 * @param tab - the active tab of the pane being drawn.
			 * @returns the body (or bodies), or null when nothing may mount.
			 */
			const renderBody = (tab) => {
				const pane = paneOf(tab);
				const floating = pane !== null && pane.host === "float";
				const live = props.active !== false && (floating || state.expanded === true);
				if (live) shown.current.add(tab.id);
				const held = pane === null ? [tab] : pane.tabs.map((id) => dockkit.getTab(state, id)).filter((entry) => entry.id === tab.id || (typeof keepMounted === "function" && keepMounted(entry) === true));
				const draw = held.filter((entry) => entry.id === tab.id ? live : shown.current.has(entry.id) && typeof keepMounted === "function" && keepMounted(entry) === true);
				if (draw.length === 0) return null;
				if (draw.length === 1) return bodies(draw[0]);
				return draw.map((entry) => entry.id === tab.id ? (0, react_jsx_runtime.jsx)(react.Fragment, {
					key: entry.id,
					children: bodies(entry)
				}) : (0, react_jsx_runtime.jsx)("div", {
					key: entry.id,
					hidden: true,
					children: bodies(entry)
				}));
			};
			if (typeof Surface !== "function") {
				return (0, react_jsx_runtime.jsx)(dockkit.DockLayout, Object.assign({}, props, {
					dropZones: "horizontal"
				}));
			}
			const Float = dockkit.FloatLayer;
			return (0, react_jsx_runtime.jsxs)(react.Fragment, {
				children: [(0, react_jsx_runtime.jsx)("div", {
					"data-dockkit-host": "dock",
					style: {
						display: "flex",
						flex: "1 1 auto",
						flexDirection: "column",
						minWidth: 0,
						minHeight: 0,
						pointerEvents: "auto"
					},
					children: (0, react_jsx_runtime.jsx)(Surface, Object.assign({}, props, {
						renderTab: renderBody
					}))
				}), typeof Float === "function" ? (0, react_jsx_runtime.jsx)(Float, {
					state: state,
					intents: props.intents,
					labels: props.labels,
					renderTab: renderBody,
					renderTabTitle: props.renderTabTitle,
					canCloseTab: props.canCloseTab
				}) : null]
			});
		}
