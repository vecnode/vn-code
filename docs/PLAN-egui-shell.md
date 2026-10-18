# Superseded: the egui shell and the pane

This plan described a native **egui** control panel with an optional `wry` web view inside
its own window — the `--features pane` build, `-Mode embed`, and the two tabs
(`control panel`, `harness`).

All of it was **deleted** on purpose, and the reason is a measurement: the panel plus the
engine was 15.1 MB of a 15.5 MB binary (removing `wry` alone saved 0.3 MB), it existed only
to draw something that is not this app's to draw, and it required a web engine per OS
(WebView2, WKWebView, WebKitGTK) that the machine already had a browser for.

The app is now a ~0.5 MB console front door with no window and no web view, and
[PLAN-controller.md](PLAN-controller.md) is the plan that replaced this one. Keep this page
only because links to it exist; nothing here is shipped behaviour.
