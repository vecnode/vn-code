//! The pane's page: the tab strip, the bar above the view, and the rectangle the engine
//! is given.
//!
//! This is the whole user-visible half of the pane, and it lives beside the engine rather
//! than inside the panel's own file (`vn-shell-egui`) for two reasons: the panel is two
//! thousand lines of control panel with a different job, and the pane's rules belong with
//! the thing they constrain.
//!
//! ## The airspace rule, kept the easy way
//!
//! A child web view paints above the GPU surface and cannot be clipped, scrolled or drawn
//! over. So the pane must never be *covered* - and this page keeps that by construction
//! rather than by cleverness: the view is given everything below the tab strip and the
//! bar, and nothing is ever drawn there, because the control panel is a **different page**
//! of the same window. The engine is only ever hidden: when the panel is in front, when
//! the host reports an overlay, and when nothing is running.
//!
//! ## Two identities, and why the URL is one
//!
//! A Stop and a Start produce a new port **and a new launch token**, so a page belongs to
//! one instance. The engine is rebuilt when the URL changes and **retired the moment the
//! instance stops** - a hidden page still holding the previous token is a credential
//! nobody is watching, which is the same rule `Status::mark_stopped` keeps by clearing
//! the URL. The URL is therefore the identity, and it is never printed: the bar draws
//! `Status::public_url`, which has the token stripped by construction.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use egui::{Align2, Color32, FontId, RichText, Ui};
use vn_shell_core::pane::{self, PanePolicy, RectPoints};
use vn_shell_core::status::{Phase, Status};
use wry::raw_window_handle::HasWindowHandle;

use crate::engine::{Engine, LoadState};

/// Which page of the window is in front.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Page {
    Panel,
    Harness,
}

/// The harness page, and the engine behind it.
pub struct PanePage {
    front: Page,
    engine: Option<Engine>,
    /// The URL the engine was built for: the instance's identity. NEVER printed, never
    /// logged - it carries the launch token.
    built_for: Option<String>,
    /// Whether the page in the engine has finished loading, set from its own callback.
    loaded: Arc<AtomicBool>,
    /// The last thing the engine refused, in its own words, so a refusal is visible
    /// rather than a rectangle that quietly stays blank.
    problem: Option<String>,
}

impl Default for PanePage {
    fn default() -> Self {
        PanePage::new()
    }
}

impl PanePage {
    /// The page opens on the CONTROL PANEL: the pane is a page you go to, not a window
    /// that starts on somebody's web page before they have pressed anything.
    pub fn new() -> PanePage {
        PanePage {
            front: Page::Panel,
            engine: None,
            built_for: None,
            loaded: Arc::new(AtomicBool::new(false)),
            problem: None,
        }
    }

    /// Start with the harness page in front.
    ///
    /// What `-Mode embed` asks for: the same window and the same two tabs, with the instance
    /// already in view instead of the control panel.
    pub fn in_front(mut self) -> PanePage {
        self.front = Page::Harness;
        self
    }

    /// Whether this page owns everything below the header, so the panel must not draw its
    /// own rows underneath the view.
    pub fn owns_the_area(&self) -> bool {
        self.front == Page::Harness
    }

    /// Draw the page.
    ///
    /// It returns **nothing**, and that is deliberate. This page used to hand two actions back
    /// to the panel - "open in my browser" and "stop" - and both are gone: with the pane the
    /// app starts no browser at all, and Stop is one control in the header rather than two.
    /// What the page owns is the engine and the rectangle; it asks for nothing.
    pub fn show<W: HasWindowHandle>(
        &mut self,
        ui: &mut Ui,
        window: &W,
        status: &Status,
        data_dir: Option<PathBuf>,
        overlay_open: bool,
    ) {
        self.tabs(ui, status);
        if self.front == Page::Panel {
            // The engine is KEPT and hidden: a page that reloads every time somebody looks
            // at the panel is a page that loses where they were.
            self.conceal();
            return;
        }
        self.bar(ui, status);
        self.view(ui, window, status, data_dir, overlay_open);
    }

    /// The two pages, and the state of the instance in one word.
    fn tabs(&mut self, ui: &mut Ui, status: &Status) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.front, Page::Panel, "control panel");
            ui.selectable_value(&mut self.front, Page::Harness, "harness");
            ui.separator();
            ui.label(
                RichText::new(format!("● {}", status.phase.label()))
                    .color(phase_colour(status.phase)),
            );
        });
    }

    /// The bar: where the harness is, and the one thing worth doing to it from here.
    ///
    /// **Reload is the only button this page has**, which is the point rather than an
    /// omission: with the pane this app starts no browser - `Open in my browser` used to live
    /// here - and **Stop is the header's own control**, so there is one Stop in the window
    /// instead of two that mean the same thing.
    ///
    /// The address is `public_url` - scheme, host and port, with the query dropped - so
    /// **the launch token is never drawn**, exactly as the panel's own address row never
    /// drew it.
    fn bar(&mut self, ui: &mut Ui, status: &Status) {
        let running = status.phase == Phase::Running;
        let has_engine = self.engine.is_some();
        let loaded = self.loaded.load(Ordering::Relaxed);
        let mut reload = false;

        ui.horizontal_wrapped(|ui| {
            match status.public_url() {
                Some(address) => {
                    ui.label(RichText::new(address).monospace());
                }
                None => {
                    ui.label(RichText::new("no address yet").weak());
                }
            }
            if let Some(uptime) = status.uptime_label() {
                ui.label(RichText::new(format!("up {uptime}")).weak());
            }
            if running && has_engine && !loaded {
                ui.label(RichText::new("· loading…").weak());
            }
            ui.separator();

            ui.add_enabled_ui(running && has_engine, |ui| {
                if ui
                    .button("Reload")
                    .on_hover_text("ask the engine for the page again")
                    .clicked()
                {
                    reload = true;
                }
            });
        });

        if reload {
            self.reload();
        }
    }

    /// The engine's rectangle, and the page inside it.
    fn view<W: HasWindowHandle>(
        &mut self,
        ui: &mut Ui,
        window: &W,
        status: &Status,
        data_dir: Option<PathBuf>,
        overlay_open: bool,
    ) {
        let rect = ui.available_rect_before_wrap();
        let running = status.phase == Phase::Running;
        let url = if running { status.navigate_url() } else { None };

        // An instance that is not running has no page, and one that has been restarted has
        // a different one.
        if !running || !page_is_current(self.built_for.as_deref(), url) {
            self.retire();
        }

        if let (Some(url), None) = (url, self.engine.as_ref()) {
            let loaded = Arc::clone(&self.loaded);
            match Engine::attach(window, url, data_dir, move |state| {
                if state == LoadState::Finished {
                    loaded.store(true, Ordering::Relaxed);
                }
            }) {
                Ok(engine) => {
                    self.loaded.store(false, Ordering::Relaxed);
                    self.engine = Some(engine);
                    self.built_for = Some(url.to_string());
                    self.problem = None;
                }
                Err(error) => {
                    // Named, never silent: an engine that refuses is the one failure this
                    // page must not hide, because the hand-off behind the button is the
                    // way round it.
                    self.problem = Some(error.to_string());
                }
            }
        }

        let policy = PanePolicy {
            is_active_page: true,
            harness_ready: running,
            overlay_open,
            rect: RectPoints {
                min_x: rect.min.x,
                min_y: rect.min.y,
                width: rect.width(),
                height: rect.height(),
            },
        };
        let want = pane::decide(&policy, ui.ctx().pixels_per_point());
        if let Some(engine) = &mut self.engine {
            if let Err(error) = engine.apply(&want) {
                self.problem = Some(error.to_string());
            }
        }

        // The engine draws over this rectangle; nothing of ours goes inside it.
        ui.allocate_rect(rect, egui::Sense::hover());

        if !running {
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                "the harness is not running — press Start above and it opens here",
                FontId::proportional(15.0),
                ui.visuals().weak_text_color(),
            );
        }
        if let Some(problem) = &self.problem {
            ui.colored_label(Color32::from_rgb(0xE0, 0x6C, 0x75), problem);
        }
    }

    /// Ask the engine for the page again.
    fn reload(&mut self) {
        let Some(url) = self.built_for.clone() else { return };
        self.loaded.store(false, Ordering::Relaxed);
        if let Some(engine) = &mut self.engine {
            if let Err(error) = engine.navigate(&url) {
                self.problem = Some(error.to_string());
            }
        }
    }

    /// Give up the page, and with it the child view: `Engine`'s own `Drop` destroys the
    /// window, which is what makes "nothing is left holding a stale token" a property of
    /// the type instead of a thing a caller has to remember.
    fn retire(&mut self) {
        self.engine = None;
        self.built_for = None;
    }

    /// Hide the view without giving up the page.
    fn conceal(&mut self) {
        if let Some(engine) = &mut self.engine {
            if let Err(error) = engine.conceal() {
                self.problem = Some(error.to_string());
            }
        }
    }
}

/// Whether the engine in hand is the page for the instance that is running.
///
/// The URL is the identity because it is what actually changes: a Stop and a Start give a
/// new port and a new launch token, so the old page is a page for an instance that no
/// longer exists.
fn page_is_current(built_for: Option<&str>, url: Option<&str>) -> bool {
    matches!((built_for, url), (Some(built), Some(url)) if built == url)
}

/// Colour of the phase badge, matching the panel's own.
fn phase_colour(phase: Phase) -> Color32 {
    match phase {
        Phase::Running => Color32::from_rgb(0x5A, 0xC8, 0x8A),
        Phase::Starting | Phase::Stopping => Color32::from_rgb(0xE0, 0xB0, 0x5A),
        Phase::Failed => Color32::from_rgb(0xE0, 0x6C, 0x75),
        Phase::Idle | Phase::Stopped => Color32::from_rgb(0x8A, 0x92, 0x9E),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_opens_on_the_control_panel_and_not_on_a_web_page() {
        let page = PanePage::new();
        assert!(!page.owns_the_area(), "the pane must not own the window before Start");
        assert_eq!(page.front, Page::Panel);
    }

    #[test]
    fn a_restarted_instance_is_a_different_page() {
        // A Stop and a Start change the port AND the token, so the old page is a page for
        // an instance that no longer exists.
        let one = "http://127.0.0.1:51347/?token=one";
        let two = "http://127.0.0.1:51348/?token=two";
        assert!(page_is_current(Some(one), Some(one)));
        assert!(!page_is_current(Some(one), Some(two)), "a new instance needs a new page");
        // Nothing built yet, or nothing running: both are "no page".
        assert!(!page_is_current(None, Some(one)));
        assert!(!page_is_current(Some(one), None));
    }

    #[test]
    fn only_the_harness_page_owns_the_area() {
        // This is the guard the panel's own hook asks, and getting it wrong draws the
        // panel's rows UNDER a web page: the panel in front, the pane still owns the
        // rectangle.
        let mut page = PanePage::new();
        assert!(!page.owns_the_area(), "the panel is in front at the start");
        page.front = Page::Harness;
        assert!(page.owns_the_area(), "the harness page owns everything below the header");
    }

    #[test]
    fn an_instance_that_is_not_running_has_no_page() {
        // `view` keeps the page in exactly one phase and retires it in every other, so a
        // stopped instance cannot leave a live page holding its token behind.
        let kept = |phase: Phase| phase == Phase::Running;
        assert!(kept(Phase::Running));
        for phase in [Phase::Idle, Phase::Starting, Phase::Stopping, Phase::Stopped, Phase::Failed] {
            assert!(!kept(phase), "{phase:?} must not keep a page");
        }
    }
}
