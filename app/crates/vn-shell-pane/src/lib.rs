//! The one crate that owns a web engine.
//!
//! ## Why this is a crate and not a module
//!
//! Three reasons, and each one is a rule this repository already keeps:
//!
//! 1. **The engine's dependency tree is large and platform-specific.** `wry` brings
//!    `webview2-com` and `windows` on Windows, `objc2-web-kit` on macOS and
//!    `gtk`/`webkit2gtk` on Linux. Isolating it here keeps the pure halves pure, keeps
//!    `cargo test` fast, and keeps a machine with no engine able to build everything.
//! 2. **It is optional.** The `pane` feature is off by default, so a build without it
//!    compiles no engine at all and this crate answers `available() == false`. Nothing
//!    the shell does today changes when the feature is off.
//! 3. **The decision is not here.** Visibility and the rectangle are
//!    [`vn_shell_core::pane`] - pure, tested, and provable with no engine in the room.
//!    This crate is the engine and nothing else: create, position, show, hide, navigate,
//!    destroy.
//!
//! ## What it deliberately does not do
//!
//! No IPC handler and no injected script. The moment the pane has a channel into the
//! shell, a page the harness serves has a way to reach the shell's process - and the
//! pane's whole security argument is that the reverse direction is one loopback URL.
//! Permissions, `window.open` and downloads are refused in P2, alongside the check that
//! proves a foreign navigation cannot be followed.

/// Whether a web engine is compiled into this build.
pub const fn available() -> bool {
    cfg!(feature = "pane")
}

#[cfg(feature = "pane")]
mod engine;

#[cfg(feature = "pane")]
mod page;

#[cfg(feature = "pane")]
pub use engine::{Engine, EngineError, LoadState};

#[cfg(feature = "pane")]
pub use page::{PageAction, PanePage};

#[cfg(test)]
mod tests {
    /// The default build has no engine, and says so rather than pretending.
    #[test]
    fn the_default_build_has_no_engine() {
        assert_eq!(super::available(), cfg!(feature = "pane"));
    }
}
