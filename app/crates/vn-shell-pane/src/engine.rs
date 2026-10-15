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
use std::path::{Path, PathBuf};

use vn_shell_core::pane::{self, PaneView, PhysicalRect};
use wry::dpi::{PhysicalPosition, PhysicalSize};
use wry::raw_window_handle::HasWindowHandle;
use wry::{
    NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse, Rect as WryRect,
    WebContext, WebView, WebViewBuilder,
};

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
        // A platform this cannot be built on yet refuses BY NAME rather than panicking -
        // see `platform_supported` for the Linux half and the work it names.
        platform_supported().map_err(|reason| EngineError(reason.to_string()))?;
        let mut context = WebContext::new(data_dir);
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(parsed.as_str())
            // The inspector is a debug build's tool, never a shipped one's.
            .with_devtools(cfg!(debug_assertions))
            // **The three seams, and each one is a rule rather than a preference.**
            //
            // The page is the harness and nothing else, so the pane grants what a chat
            // interface cannot work without and refuses the rest BY NAME - a refusal the
            // engine cannot talk its way out of, because the decision is taken here and
            // handed to it.
            //
            // Why the whole set is possible at all: `with_permission_handler` arrives in
            // wry 0.57. In 0.55 the only mention of a permission in the Windows backend
            // ALLOWS clipboard reads and lets every other kind fall through to the engine's
            // own default, and the macOS delegate GRANTS media capture outright - so a pane
            // that denies camera and microphone could not be built on it.
            .with_permission_handler(permission_response)
            // A window is never opened from inside the pane. A page that can put a window
            // on the desktop is a page that can put one over the panel, and the reader's
            // own way to a browser is a click on the bar.
            .with_new_window_req_handler(|_url, _features| NewWindowResponse::Deny)
            // The pane shows the harness; it does not fetch files. Refused with no path
            // offered, so nothing can be written anywhere the app has not chosen.
            .with_download_started_handler(|_url, _path| false)
            // Copy and paste work for the same reason the ONE granted permission does: the
            // harness's own buttons and composer use them. Without this the page has no
            // clipboard at all on Windows and Linux.
            .with_clipboard(true)
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
}

/// Whether the pane can be built on this platform YET, and why not when it cannot.
///
/// Windows and macOS are the engine's own documented paths: on macOS `build_as_child` makes
/// the view an `NSView` subview, which needs no extra pump, and on Windows it is a child HWND.
///
/// **Linux needs one, and that is why it refuses here.** wry documents that its Linux
/// `build_as_child` requires `gtk::init` plus `gtk::main_iteration_do` advanced alongside
/// winit's event loop - and that it **PANICS** when `gtk::init` was not called in the thread.
/// It is also X11-only, so a Wayland session needs XWayland. That is P4's work, on a machine
/// with libwebkit2gtk to measure it; until then a Linux build gets a sentence instead of a
/// panic, and the browser hand-off stays the surface there.
#[cfg(target_os = "linux")]
fn platform_supported() -> Result<(), &'static str> {
    Err(
        "the pane is not built for Linux yet: wry's child web view needs a GTK loop pumped \
         beside winit's and works on X11 (or XWayland) only - see P4 of \
         docs/PLAN-egui-shell.md. A Linux build without `--features pane` uses the browser \
         hand-off, which is the floor under the pane everywhere",
    )
}

#[cfg(not(target_os = "linux"))]
fn platform_supported() -> Result<(), &'static str> {
    Ok(())
}

/// Which permissions the pane grants: the clipboard, and nothing else.
///
/// The one exception is deliberate and narrow. A chat interface's copy buttons and its
/// composer are clipboard work, and wry 0.55 made the same choice on Windows for the same
/// reason. Everything a viewer has no business asking for - camera, microphone, screen
/// capture, location, notifications, MIDI, sensors, and whatever the engine adds next -
/// falls to `Deny` rather than to the engine's default, because "the engine will probably
/// ask the person" is not a rule.
fn permission_response(kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::ClipboardRead => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

/// Physical pixels into the engine's own rectangle type.
fn rect(bounds: PhysicalRect) -> WryRect {
    WryRect {
        position: PhysicalPosition::new(bounds.x, bounds.y).into(),
        size: PhysicalSize::new(bounds.width, bounds.height).into(),
    }
}

/// What a purge took away, and what it could not.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PurgeReport {
    /// The files and directories that were removed, by name.
    pub removed: Vec<String>,
    /// Files that STILL contain `token=` after the purge. Named, never hidden: a build that
    /// cannot keep a rule has to say which file broke it.
    pub still_carrying: Vec<String>,
}

/// The file names a web engine records a VISIT in, matched by PREFIX so the `-journal` siblings
/// come with them.
///
/// MEASURED on this machine, after the pane had loaded the harness once: `?token=` was found in
/// `History`, `Favicons` and `Top Sites` under `EBWebView/Default`, inside the pane's own profile.
const NAVIGATION_RECORDS: &[&str] = &[
    "History",
    "Favicons",
    "Top Sites",
    "Visited Links",
    "Network Action Predictor",
    "Shortcuts",
    "Current Session",
    "Current Tabs",
    "Last Session",
    "Last Tabs",
];

/// Take away what the engine recorded about **where the pane went**.
///
/// ## Why this exists, and why it is a security rule rather than a tidy-up
///
/// The launch token is a live credential, and the oldest rule in this pack is that it is never
/// written to a file. A web engine keeps a browsing record and the pane's engine is no
/// exception: MEASURED, the full URL - `?token=` and all - was sitting in three files inside the
/// pane's own profile. No amount of care in this app changes what the engine does with a URL it
/// was given, so the app takes the record away again.
///
/// ## When it runs, and why that matters
///
/// At STARTUP, before any view exists - and again, best effort, when a view is given up. Startup
/// is the one that is guaranteed: a delete while the engine is alive is a sharing violation, so
/// the pass that cannot fail is the one that runs before anything holds the files.
///
/// The list is a prefix list plus a scan rather than a closed list, because engine versions add
/// files: anything left that still carries the token is RETURNED rather than hidden, so the next
/// engine version that invents a record file is visible instead of silent.
pub fn purge_navigation_records(data_dir: &Path) -> PurgeReport {
    let mut report = PurgeReport::default();
    let profile = data_dir.join("EBWebView").join("Default");
    let Ok(entries) = std::fs::read_dir(&profile) else {
        // No profile yet - a first run. Nothing to take away, and that is not a failure.
        return report;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !NAVIGATION_RECORDS.iter().any(|prefix| name.starts_with(prefix)) {
            continue;
        }
        let path = entry.path();
        let gone = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if gone {
            report.removed.push(name);
        }
    }

    // What is left, in case an engine version records a visit somewhere this build has never
    // heard of. Bounded per file, so a cache blob is never read into memory to be searched.
    let mut stack = vec![profile];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(metadata) = entry.metadata() else { continue };
            if metadata.len() > 4 * 1024 * 1024 {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if bytes.windows(6).any(|window| window == &b"token="[..]) {
                report.still_carrying.push(
                    path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
                );
            }
        }
    }
    report
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
    fn the_purge_takes_the_visit_record_away_and_names_what_it_cannot() {
        // A scratch root the harness can point away from, mirroring vn-shell-core's rule: a
        // host that denies %TEMP% to a child must not turn this into a failure about the host.
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let dir = root.join(format!("vncode-pane-purge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let default = dir.join("EBWebView").join("Default");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::write(default.join("History"), b"http://127.0.0.1:1/?token=x").unwrap();
        std::fs::write(default.join("History-journal"), b"junk").unwrap();
        std::fs::write(default.join("Favicons"), b"http://127.0.0.1:1/?token=x").unwrap();
        std::fs::write(default.join("Cookies"), b"a file that is not a visit record").unwrap();

        let report = purge_navigation_records(&dir);
        assert!(!default.join("History").exists(), "the history database must go");
        assert!(!default.join("History-journal").exists(), "its -journal sibling goes with it");
        assert!(!default.join("Favicons").exists(), "the favicon record carries the same URL");
        assert!(default.join("Cookies").exists(), "a file that is not a visit record stays");
        assert!(report.removed.iter().any(|name| name == "History"), "{report:?}");
        assert!(report.still_carrying.is_empty(), "{report:?}");

        // A file this build does not know about is NAMED rather than hidden - that is how the
        // next engine version that invents a record file gets noticed.
        std::fs::write(default.join("SomethingNew"), b"http://127.0.0.1:1/?token=x").unwrap();
        let report = purge_navigation_records(&dir);
        assert_eq!(report.still_carrying, vec!["SomethingNew".to_string()], "{report:?}");

        // ...and a directory that does not exist yet is not a failure: that is the first run.
        let report = purge_navigation_records(&dir.join("never-created"));
        assert_eq!(report, PurgeReport::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_platform_the_pane_is_not_built_for_yet_refuses_by_name() {
        // The point of the function is that it is TOTAL: wherever this is compiled, asking
        // whether the platform is supported gives an answer rather than reaching wry's
        // documented panic on Linux. On the platforms this can be run on, the answer is yes.
        #[cfg(target_os = "linux")]
        {
            let reason = platform_supported().expect_err("Linux has no pumped GTK loop yet");
            assert!(reason.contains("P4"), "{reason}");
            assert!(reason.contains("hand-off"), "{reason}");
        }
        #[cfg(not(target_os = "linux"))]
        assert!(platform_supported().is_ok());
    }

    #[test]
    fn the_pane_grants_the_clipboard_and_denies_everything_else() {
        assert!(matches!(
            permission_response(PermissionKind::ClipboardRead),
            PermissionResponse::Allow
        ));
        // A viewer asks for none of these, and the pane answers for itself rather than
        // leaving it to the engine's default flow.
        for kind in [
            PermissionKind::Microphone,
            PermissionKind::Camera,
            PermissionKind::DisplayCapture,
            PermissionKind::Geolocation,
            PermissionKind::Notifications,
            PermissionKind::Midi,
            PermissionKind::Sensors,
        ] {
            assert!(
                matches!(permission_response(kind), PermissionResponse::Deny),
                "a permission other than the clipboard was not denied"
            );
        }
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
