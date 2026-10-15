//! The pane: where the harness is drawn inside the shell's own window, when it may be
//! seen, and what it may load.
//!
//! ## The measured fact this module exists for
//!
//! An OS web view created as a **child of the window** is a sibling of the surface the
//! panel paints on (`pane-spike`, P0: `WEBVIEW-UP` + `PAGE-LOADED` + `JS-RAN` with the
//! engine's own runtime `155.0.4283.45`, while `chrome.exe` launched by the same process
//! died `0x80000003`). Being a sibling and not a layer, it is drawn **above** everything
//! egui draws, and it cannot be clipped, scrolled or drawn over. There is no z-order to
//! negotiate: there is only *is it visible right now*, and getting that wrong shows a web
//! page through the panel's own dialog.
//!
//! So the decision is a pure function of facts the panel already has, and it is
//! `cargo test` cases rather than something anybody checks by looking at a window.
//!
//! ## The one arithmetic a scaled display gets wrong
//!
//! The panel measures in egui **points**; the engine wants **physical pixels**. The
//! conversion happens here, once, with the window's own scale factor, and there is a test
//! per scale the three platforms actually use - because the alternative is a rectangle
//! that is right on a 100% display and half-size on a 200% one.
//!
//! No engine is named in this module and none is needed to test any of it.

use url::Url;

/// A rectangle in egui points (logical pixels): what the panel measures.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RectPoints {
    pub min_x: f32,
    pub min_y: f32,
    pub width: f32,
    pub height: f32,
}

/// A rectangle in physical pixels: what the engine is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Everything the panel knows when it decides whether the pane may be seen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanePolicy {
    /// The pane's own page is the one in front, and the control panel is not.
    pub is_active_page: bool,
    /// The harness printed its ready line, so there is something to show.
    pub harness_ready: bool,
    /// An egui overlay is open: a modal, a combo box's open list, the first-run screen.
    /// Every one of those would be drawn *under* the pane, so the pane gets out of the way.
    pub overlay_open: bool,
    /// The rectangle the pane would occupy, in points.
    pub rect: RectPoints,
}

/// What the pane should do about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaneView {
    /// Whether the engine's view may be shown. Everything else about it is unchanged.
    pub visible: bool,
    /// The rectangle it occupies, in physical pixels - reported **even when hidden**, so
    /// the engine is positioned before it is shown and showing never moves it.
    pub bounds: PhysicalRect,
}

/// Whether the pane may be seen, and where it goes.
pub fn decide(policy: &PanePolicy, scale_factor: f32) -> PaneView {
    let bounds = physical(policy.rect, scale_factor);
    // A rectangle with no extent is not a pane: showing it would be showing a 0-pixel
    // child window, which some engines treat as a full-window one.
    let has_extent = bounds.width > 0 && bounds.height > 0;
    let visible =
        policy.is_active_page && policy.harness_ready && !policy.overlay_open && has_extent;
    PaneView { visible, bounds }
}

/// Points to physical pixels.
///
/// A scale factor that is not one - zero, negative, NaN, infinite - falls back to 1.0
/// rather than poisoning the rectangle: a window that reports a nonsense scale is a
/// window whose pane should be *missized honestly*, not invisible or enormous.
pub fn physical(rect: RectPoints, scale_factor: f32) -> PhysicalRect {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 { scale_factor } else { 1.0 };
    PhysicalRect {
        // A child view is inside its parent: a negative origin is not a place.
        x: coordinate(rect.min_x * scale),
        y: coordinate(rect.min_y * scale),
        width: extent(rect.width * scale),
        height: extent(rect.height * scale),
    }
}

fn coordinate(value: f32) -> i32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.round().min(i32::MAX as f32) as i32
}

fn extent(value: f32) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.round().min(u32::MAX as f32) as u32
}

/// The URL the pane may be given, or why it may not.
///
/// The same rule as the ready line and as `browser::command_with`, applied at the last
/// function before a navigation - a rule that holds at only one end of a pipe is not a
/// rule. A URL that is not the harness's own loopback address is refused by name; a link
/// the reader clicks inside the page belongs to their browser, not to this window.
pub fn may_load(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|error| format!("'{url}' is not a URL: {error}"))?;
    if !crate::urlpolicy::is_internal(&parsed) {
        return Err(format!(
            "refusing to load {}: only the harness's own loopback address may be shown inside this window",
            parsed.host_str().unwrap_or("that address")
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> RectPoints {
        RectPoints { min_x: 10.0, min_y: 20.0, width: 800.0, height: 600.0 }
    }

    fn policy(is_active_page: bool, harness_ready: bool, overlay_open: bool) -> PanePolicy {
        PanePolicy { is_active_page, harness_ready, overlay_open, rect: rect() }
    }

    #[test]
    fn the_pane_is_shown_only_in_front_ready_and_uncovored() {
        // Written as a table because every one of the three is a measured way to show a
        // web page through the panel: the other page, no harness behind it, a dialog.
        let cases = [
            (true, true, false, true),
            (false, true, false, false),
            (true, false, false, false),
            (true, true, true, false),
            (false, false, true, false),
        ];
        for (is_active_page, harness_ready, overlay_open, expected) in cases {
            let view = decide(&policy(is_active_page, harness_ready, overlay_open), 1.0);
            assert_eq!(
                view.visible, expected,
                "active={is_active_page} ready={harness_ready} overlay={overlay_open}"
            );
        }
    }

    #[test]
    fn a_rectangle_that_is_not_a_rectangle_is_never_shown() {
        for rect in [
            RectPoints { min_x: 0.0, min_y: 0.0, width: 0.0, height: 600.0 },
            RectPoints { min_x: 0.0, min_y: 0.0, width: 800.0, height: 0.0 },
            RectPoints { min_x: 0.0, min_y: 0.0, width: -800.0, height: 600.0 },
            RectPoints { min_x: 0.0, min_y: 0.0, width: f32::NAN, height: 600.0 },
        ] {
            let view = decide(&PanePolicy { rect, ..policy(true, true, false) }, 1.0);
            assert!(!view.visible, "{rect:?} was shown");
        }
    }

    #[test]
    fn points_become_physical_pixels_at_every_scale_the_platforms_use() {
        // Windows 100/125/150%, macOS 200%, and a fractional one that does not round.
        assert_eq!(physical(rect(), 1.0), PhysicalRect { x: 10, y: 20, width: 800, height: 600 });
        assert_eq!(physical(rect(), 1.25), PhysicalRect { x: 13, y: 25, width: 1000, height: 750 });
        assert_eq!(physical(rect(), 1.5), PhysicalRect { x: 15, y: 30, width: 1200, height: 900 });
        assert_eq!(physical(rect(), 1.75), PhysicalRect { x: 18, y: 35, width: 1400, height: 1050 });
        assert_eq!(physical(rect(), 2.0), PhysicalRect { x: 20, y: 40, width: 1600, height: 1200 });
    }

    #[test]
    fn a_scale_factor_that_is_not_a_scale_factor_falls_back_to_one() {
        let honest = physical(rect(), 1.0);
        for nonsense in [0.0, -1.5, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(physical(rect(), nonsense), honest, "{nonsense} was not caught");
        }
    }

    #[test]
    fn a_negative_origin_is_clamped_into_the_window() {
        let off = RectPoints { min_x: -50.0, min_y: -8.0, width: 800.0, height: 600.0 };
        assert_eq!(physical(off, 1.0), PhysicalRect { x: 0, y: 0, width: 800, height: 600 });
    }

    #[test]
    fn bounds_are_reported_even_when_the_pane_is_hidden() {
        // The engine is positioned before it is shown, so showing it never moves it - a
        // pane that jumps on the frame it appears is the sort of thing a person reports
        // as "it flickers".
        let view = decide(&policy(false, true, false), 1.5);
        assert!(!view.visible);
        assert_eq!(view.bounds, PhysicalRect { x: 15, y: 30, width: 1200, height: 900 });
    }

    #[test]
    fn only_the_harness_loopback_address_may_be_loaded() {
        for allowed in [
            // A placeholder, deliberately too short to look like a credential: the check
            // that scans this repository fires on a launch-token shape, and a test that
            // ships what looks like a live token is a test that fails the pack's own
            // no-secrets check.
            "http://127.0.0.1:51347/?token=x",
            "http://localhost:51347/",
            "https://[::1]:9/",
        ] {
            assert!(may_load(allowed).is_ok(), "{allowed} was refused");
        }
        for refused in [
            "http://evil.example/?token=x",
            "https://127.0.0.1.evil.example/",
            "file:///etc/passwd",
            "data:text/html,<h1>hi</h1>",
            "javascript:alert(1)",
            "about:blank",
            "not a url at all",
        ] {
            let error = may_load(refused).unwrap_err();
            assert!(error.contains("not a URL") || error.contains("refusing to load"), "{error}");
        }
        // The refusal names what it refused, so a log line is evidence.
        let error = may_load("http://evil.example/").unwrap_err();
        assert!(error.contains("evil.example"), "{error}");
    }
}
