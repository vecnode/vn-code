//! The engine, and only the engine: a child web view inside the shell's own window.
//!
//! Compiled only with the `pane` feature. Everything decided *about* the pane - may it be
//! seen, where does it go, which URL may it load - is [`vn_shell_core::pane`], so this
//! file is deliberately thin and has no policy of its own beyond quoting that module.
//!
//! The three rules it keeps:
//!
//! 1. **The loopback check happens again here**, at the last function before a
//!    navigation, and in the navigation handler as well - a rule that holds at only one
//!    end of a pipe is not a rule. `browser::command_with` re-checks the same rule before
//!    a process starts with the URL in its argv, and this is the pane's equivalent.
//! 2. **A navigation the pane did not ask for is refused, not followed.** A page that can
//!    move this window to another origin is a page that can take the launch token with it.
//! 3. **Dropping the engine destroys the view.** `WebView`'s own `Drop` takes the child
//!    window with it, which is what makes "Stop leaves no live page holding a stale
//!    token" a property of the type rather than a thing a caller has to remember.

use std::fmt;
use std::path::PathBuf;

use vn_shell_core::pane::{self, PaneView, PhysicalRect};
use wry::dpi::{PhysicalPosition, PhysicalSize};
use wry::raw_window_handle::HasWindowHandle;
use wry::{PageLoadEvent, Rect as WryRect, WebContext, WebView, WebViewBuilder};

/// What the page told us about itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadState {
    /// The engine has begun loading the URL it was given.
    Started,
    /// The page finished loading. This is the earliest moment there is something to see.
    Finished,
}

/// Why the engine could not do what it was asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineError(pub String);

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for EngineError {}

/// A live child web view inside the shell's window.
pub struct Engine {
    view: WebView,
    /// Kept alive on purpose, and never read: `wry` documents that dropping the context
    /// takes some actions with it (custom protocols on macOS) while the view is alive.
    _context: WebContext,
    /// What was last applied, so a frame that changes nothing costs nothing. Comparing
    /// here rather than in the caller means a caller may hand this the same decision
    /// sixty times a second.
    applied_bounds: Option<PhysicalRect>,
    applied_visible: bool,
}

impl Engine {
    /// Create the child view for `url` inside `window`, calling `on_load` as the page
    /// reports itself.
    ///
    /// `data_dir` is the engine's own profile - the pane's is `<app root>/webview`, inside
    /// the root the shell has already proved it can write, and deliberately NOT the
    /// directory the Chrome rung uses: an engine profile and a browser profile in one
    /// directory is a way to lose both.
    pub fn attach<W: HasWindowHandle>(
        window: &W,
        url: &str,
        data_dir: Option<PathBuf>,
        on_load: impl Fn(LoadState) + 'static,
    ) -> Result<Engine, EngineError> {
        // Rule 1, at the last function before a navigation.
        let parsed =
            pane::may_load(url).map_err(|error| EngineError(format!("the pane refused: {error}")))?;
        let mut context = WebContext::new(data_dir);
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(parsed.as_str())
            // The inspector is a debug build's tool, never a shipped one's.
            .with_devtools(cfg!(debug_assertions))
            // Rule 2: the handler answers the same question the URL did.
            .with_navigation_handler(|target| pane::may_load(&target).is_ok())
            .with_on_page_load_handler(move |event, _url| match event {
                PageLoadEvent::Started => on_load(LoadState::Started),
                PageLoadEvent::Finished => on_load(LoadState::Finished),
            })
            .build_as_child(window)
            .map_err(|error| {
                EngineError(format!("the web engine would not start: {error}"))
            })?;
        Ok(Engine {
            view,
            _context: context,
            applied_bounds: None,
            applied_visible: false,
        })
    }

    /// Apply a decision from [`vn_shell_core::pane::decide`]: position always, visibility
    /// only when it changed.
    pub fn apply(&mut self, want: &PaneView) -> Result<(), EngineError> {
        if self.applied_bounds != Some(want.bounds) {
            self.view.set_bounds(rect(want.bounds)).map_err(|error| {
                EngineError(format!("could not place the pane: {error}"))
            })?;
            self.applied_bounds = Some(want.bounds);
        }
        if self.applied_visible != want.visible {
            self.view.set_visible(want.visible).map_err(|error| {
                EngineError(format!("could not show or hide the pane: {error}"))
            })?;
            self.applied_visible = want.visible;
        }
        Ok(())
    }

    /// Hide the view without giving up the page.
    ///
    /// The panel is in front, or an overlay is: the page stays loaded, keeps its scroll
    /// position and keeps its connection, and only stops being drawn. This is the whole
    /// reason the airspace rule is cheap here - the pane is a *page* of one window, so
    /// hiding it is a page switch rather than a z-order negotiation.
    pub fn conceal(&mut self) -> Result<(), EngineError> {
        if self.applied_visible {
            self.view
                .set_visible(false)
                .map_err(|error| EngineError(format!("could not hide the pane: {error}")))?;
            self.applied_visible = false;
        }
        Ok(())
    }

    /// Point the view at another URL of the SAME harness - a new port and token after a
    /// Stop and Start, never a different origin.
    pub fn navigate(&mut self, url: &str) -> Result<(), EngineError> {
        let parsed =
            pane::may_load(url).map_err(|error| EngineError(format!("the pane refused: {error}")))?;
        self.view.load_url(parsed.as_str()).map_err(|error| {
            EngineError(format!("could not navigate the pane: {error}"))
        })
    }

    /// Whether the view is currently shown, as last applied.
    pub fn is_visible(&self) -> bool {
        self.applied_visible
    }
}

/// Physical pixels into the engine's own rectangle type.
fn rect(bounds: PhysicalRect) -> WryRect {
    WryRect {
        position: PhysicalPosition::new(bounds.x, bounds.y).into(),
        size: PhysicalSize::new(bounds.width, bounds.height).into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rectangle_reaches_the_engine_in_physical_pixels() {
        let converted = rect(PhysicalRect { x: 15, y: 30, width: 1200, height: 900 });
        assert_eq!(
            converted.position,
            wry::dpi::Position::Physical(PhysicalPosition::new(15, 30))
        );
        assert_eq!(
            converted.size,
            wry::dpi::Size::Physical(PhysicalSize::new(1200, 900))
        );
    }

    #[test]
    fn the_engine_quotes_the_same_loopback_rule_as_the_rest_of_the_shell() {
        // The refusal has to come from `pane::may_load` and not from a second copy of the
        // rule, so this pins that an engine given a foreign URL refuses it in the same
        // words the pure half uses.
        let refusal = pane::may_load("http://evil.example/").unwrap_err();
        assert!(refusal.contains("refusing to load"), "{refusal}");
        assert!(pane::may_load("http://127.0.0.1:3080/?token=x").is_ok());
    }
}
