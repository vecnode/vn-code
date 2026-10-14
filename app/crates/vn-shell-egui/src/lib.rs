//! The control panel: the page the shell OPENS on, and the only place the instance
//! can be ended.
//!
//! Five rules shape everything in this file.
//!
//! 1. **One decision comes first.** A home is chosen once, on the first-run screen, and
//!    that screen is the whole window: the cards that answer it, one of them
//!    recommended, and nothing else. Everything a person needs is ON the card (what is
//!    in that home, what a copy would bring, where a fresh one would go), and the
//!    decision itself is `vn_shell_core::firstrun` - a `cargo test` case, not a reading
//!    of this file.
//! 2. **Nothing is started until Start**, and Start runs the same launch path the
//!    two launcher scripts already use. Opening the app spawns no child process and
//!    binds no port.
//! 3. **The panel never writes the status.** It reads what the supervisor recorded
//!    and sends orders; one writer is what keeps "is it running" from having two
//!    answers.
//! 4. **The panel never draws a secret.** The key row is built from
//!    `keystate::console_line`'s inputs (a flag and a layer NAME), and the URL is
//!    drawn through `Status::public_url`, which has no query and therefore no
//!    launch token.
//! 5. **The panel does not draw the harness.** There is no web view here and there
//!    is not going to be one: the interface is a web application, this app opens it
//!    in a browser it found (`browser.rs`), and the panel's job is to say which one,
//!    and to make changing your mind one click.
//!
//! After the choice the window is four rows and three buttons - home, pack, key,
//! browser, with Start / Open tab / Stop - and **every diagnostic is one disclosure
//! away** (`Details`, closed by default). Nothing was deleted to get there: the pin,
//! the runtime, the composed environment, the pid, the location map, the refusals and
//! the notes all moved, because an inspector is not a control panel.
//!
//! The three things it can do to the machine - install the pack, adopt a home, and
//! choose the browser - all go through the same rule: the panel decides, the
//! supervisor or the runner performs, and the log carries the evidence.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eframe::egui;
use egui::{Color32, RichText};

use vn_shell_core::appprefs::AppPrefs;
use vn_shell_core::browser::{self, Browser};
use vn_shell_core::firstrun::{self, Card, Kind as CardKind, Where};
use vn_shell_core::home::Origin;
use vn_shell_core::keystate::KeyState;
use vn_shell_core::options::Options;
use vn_shell_core::prefs::Preferences;
use vn_shell_core::status::{Phase, Status};
use vn_shell_core::windowstate::WindowState;
use vn_shell_core::{urlpolicy, windowstate};
use vn_shell_paths::{human, Kind, Row};
use vn_shell_runtime::{
    Adopt, Console, EntryPoints, Plan, Setup, SetupKind, StopOutcome, Supervisor,
};

/// How often the panel re-reads the supervisor even when nothing has happened.
const POLL: Duration = Duration::from_millis(250);

/// How many log lines the panel draws. The RING keeps more; this is what fits on
/// screen at once.
const LOG_LINES: usize = 400;

/// The two colours a row needs when it is telling somebody something is wrong, or that
/// something is right. The palette's own accent is for the app's own voice.
const WARN: Color32 = Color32::from_rgb(0xe5, 0x39, 0x35);
const OK: Color32 = Color32::from_rgb(0x4c, 0xaf, 0x50);

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------
/// Two colours the panel needs, taken from the profile's own theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub background: Color32,
    pub accent: Color32,
}

impl Palette {
    /// The page's theme, as the native chrome's palette.
    ///
    /// These are the pack's own extension themes plus the two base preferences,
    /// and the values are chosen to sit beside the page rather than to match it
    /// pixel for pixel - the seam that matters is the FIRST frame, and a dark
    /// frame around a green page is what makes an embedded UI look bolted on.
    /// An unknown name falls back to the base preference and then to dark, so a
    /// theme this build has never heard of cannot make the panel unreadable.
    pub fn for_theme(name: &str) -> Palette {
        match name {
            "light" => Palette {
                background: Color32::from_rgb(0xf7, 0xf7, 0xf5),
                accent: Color32::from_rgb(0x2b, 0x5d, 0xd6),
            },
            "hacker" => Palette {
                background: Color32::from_rgb(0x0a, 0x0e, 0x0a),
                accent: Color32::from_rgb(0x00, 0xff, 0x41),
            },
            "nord" => Palette {
                background: Color32::from_rgb(0x2e, 0x34, 0x40),
                accent: Color32::from_rgb(0x88, 0xc0, 0xd0),
            },
            "monokai" => Palette {
                background: Color32::from_rgb(0x27, 0x28, 0x22),
                accent: Color32::from_rgb(0xf9, 0x26, 0x72),
            },
            "cyber" => Palette {
                background: Color32::from_rgb(0x04, 0x06, 0x0d),
                accent: Color32::from_rgb(0x00, 0xd9, 0xff),
            },
            _ => Palette {
                background: Color32::from_rgb(0x14, 0x16, 0x1a),
                accent: Color32::from_rgb(0x4f, 0x8c, 0xff),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Everything the panel was handed
// ---------------------------------------------------------------------------
/// What the binary knows and the panel draws.
pub struct ShellContext {
    pub options: Options,
    pub plan: Plan,
    pub supervisor: Arc<Supervisor>,
    /// The one transcript: the supervisor and the installer both write to it, and
    /// the log panel draws it.
    pub console: Arc<Console>,
    /// Install and uninstall, run through the same entry points a person clicks.
    pub setup: Arc<Setup>,
    /// The runner behind a copy out of a home this app did not create.
    pub adopt: Arc<Adopt>,
    /// Where those entry points are. `None` means this app is not sitting beside a
    /// checkout - a fact the panel shows rather than an error.
    pub setup_entries: Option<EntryPoints>,
    /// The checkout or distribution root, for the message when `setup_entries` is
    /// `None`.
    pub root: Option<std::path::PathBuf>,
    pub paths: Vec<Row>,
    pub profiles: Vec<String>,
    pub prefs: Preferences,
    pub key_state: KeyState,
    /// Shared with the binary, which writes it on the way out. The panel only ever
    /// folds a reading into it through `WindowState::merge`.
    pub geometry: Arc<Mutex<WindowState>>,
    /// The browsers found on this machine, Chrome first, with the OS opener last.
    pub browsers: Vec<Browser>,
    /// The one this run will use.
    pub browser: Browser,
    /// The app's own preferences, and the root they are written into. The panel is
    /// the ONLY writer: a browser choice or a home choice is a click, and a click
    /// that did not persist would be a click that lied.
    pub app_prefs: AppPrefs,
    pub prefs_root: Option<std::path::PathBuf>,
}

/// What to do the moment the step now running has finished.
///
/// One field rather than a queue: at most one thing can be waiting, and each variant
/// exists because the action behind it must not run at the same time as the action in
/// front of it. `InstallPack` waits for a Stop (the installer re-links the profile);
/// `Start` waits for an install (a home with no pack would start a bare harness).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Next {
    InstallPack,
    Start,
}

/// What the pack row says, from the profile's own file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackState {
    /// This pack is in the profile the harness will load.
    Installed(usize),
    /// It is not, and the number says how big the profile is anyway.
    Bare(usize),
}

/// The running application.
pub struct Shell {
    context: ShellContext,
    sizes: Vec<Option<u64>>,
    /// The pid whose URL has already been opened in a browser, so one tab is opened
    /// per instance and not one per frame.
    opened_for: Option<u32>,
    /// A Stop is in flight: the button is disabled and the label says so.
    stopping: bool,
    /// Where the thread running Stop publishes its answer.
    stop_outcome: Option<Arc<Mutex<Option<StopOutcome>>>>,
    last_stop: Option<StopOutcome>,
    /// The last thing the panel itself had to say (a refused Start, say).
    notice: Option<String>,
    /// Whether the web profile lists this pack, and when that was last checked.
    /// Re-read on a slow tick rather than every frame: it is a file on disk, and
    /// the answer changes only when an install or an uninstall has run.
    pack_note: Option<String>,
    pack_checked: Option<std::time::Instant>,
    /// So a setup run finishing forces that re-read without polling for it.
    setup_was_running: bool,
    /// The second click of Adopt: take the credentials file too. Off by default, and
    /// it is a byte copy - the key's value is never read into this process.
    adopt_key: bool,
    /// What the panel last had to say about the offer itself (an unreadable source).
    adopt_note: Option<String>,
    /// Which browser the launch actually used, and whether it worked: the panel says
    /// so rather than leaving the reader to guess whether the tab opened.
    surface: Option<String>,
    /// The home question, surveyed ONCE.
    ///
    /// Surveyed rather than computed per frame, because a survey PROBES - it writes a
    /// file - and a probe per frame would be a write per frame. `None` means this app
    /// has no root of its own, which is a named failure the panel draws rather than a
    /// screen it cannot honour.
    place: Option<Where>,
    /// A step waiting for the one now running (see [`Next`]).
    next: Option<Next>,
    /// The one disclosure: everything diagnostic, closed by default.
    details_open: bool,
}

impl Shell {
    pub fn new(context: ShellContext) -> Shell {
        let sizes = context.paths.iter().map(Row::size).collect();
        let place = context.plan.app_root().map(|root| {
            Where::survey(vn_shell_core::home::existing_default_home().as_deref(), root)
        });
        Shell {
            context,
            sizes,
            place,
            next: None,
            details_open: false,
            opened_for: None,
            stopping: false,
            stop_outcome: None,
            last_stop: None,
            notice: None,
            pack_note: None,
            pack_checked: None,
            setup_was_running: false,
            adopt_key: false,
            adopt_note: None,
            surface: None,
        }
    }

    // -----------------------------------------------------------------------
    // The first-run choice
    // -----------------------------------------------------------------------

    /// Whether the home has to be chosen before the panel means anything.
    ///
    /// Asked of the person exactly once, and only while NOBODY ELSE has named the home:
    /// a `-DshHome` is somebody typing a path, and an inherited `DSH_HOME` is the
    /// session that started this app saying where its own state lives. Everything else
    /// - the installation on the machine, this app's own root - is the app GUESSING, and
    /// a guess is exactly what this screen replaces.
    fn needs_setup(&self) -> bool {
        if self.place.is_none() || self.context.app_prefs.home.is_some() {
            return false;
        }
        if self.context.options.dsh_home.is_some() {
            return false;
        }
        !matches!(
            self.context.plan.home.home.as_ref().map(|selection| selection.origin),
            Some(Origin::Inherited)
        )
    }

    /// The whole window, while the home is unchosen: one question, and the cards that
    /// answer it.
    fn setup_screen(&mut self, ui: &mut egui::Ui) {
        let Some(place) = self.place.clone() else { return };
        let cards = place.cards();
        let preselected = place.preselected().map(|card| card.kind);
        egui::CentralPanel::default().show(ui, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.add_space(14.0);
                ui.label(
                    RichText::new("Where should your sessions, skills and key live?")
                        .size(19.0)
                        .strong(),
                );
                ui.label(
                    RichText::new(
                        "Pick one. It is remembered, and `Change` on the next screen brings this back.",
                    )
                    .weak(),
                );
                ui.add_space(12.0);
                for card in &cards {
                    self.setup_card(ui, card, preselected == Some(card.kind));
                    ui.add_space(8.0);
                }
                if let Some(notice) = self.notice.clone() {
                    ui.add_space(4.0);
                    ui.label(RichText::new(format!("! {notice}")).color(WARN));
                }
                ui.add_space(8.0);
                ui.separator();
                // The one fact about this app's own root the choice depends on.
                ui.label(RichText::new(root_line(&self.context.plan)).weak());
                for note in self.context.plan.notes.clone() {
                    ui.label(RichText::new(format!("note: {note}")).weak());
                }
            });
        });
    }

    /// One card. Everything a person needs to choose is on it, the button IS the
    /// choice, and a card that cannot be honoured says why in one sentence rather than
    /// offering a button that would fail.
    fn setup_card(&mut self, ui: &mut egui::Ui, card: &Card, preselected: bool) {
        let busy = self.context.setup.is_running() || self.context.adopt.is_running();
        ui.group(|ui| {
            ui.horizontal(|ui| {
                if preselected {
                    ui.label(RichText::new("▸").color(self.palette().accent).strong());
                }
                ui.label(RichText::new(&card.title).strong());
                if card.recommended {
                    ui.label(RichText::new("· recommended").color(self.palette().accent));
                }
            });
            for fact in &card.facts {
                ui.label(RichText::new(fact).weak());
            }
            if let Some(reason) = card.unavailable.as_deref() {
                ui.label(RichText::new(reason).color(WARN));
            }
            ui.horizontal(|ui| {
                if card.kind == CardKind::CopyExisting && card.available {
                    // The offer is decided by the file's SIZE; this tick is what makes
                    // the copy itself a byte copy, still never a read.
                    ui.checkbox(&mut self.adopt_key, "include my key")
                        .on_hover_text("copies .credentials.yaml byte for byte");
                }
                let label = match card.kind {
                    CardKind::UseExisting => "Use this home",
                    CardKind::CopyExisting => "Copy it here and use it",
                    CardKind::CreateHere => "Create it here",
                };
                if ui.add_enabled(card.available && !busy, egui::Button::new(label)).clicked() {
                    self.apply_choice(card.kind);
                }
            });
        });
    }

    /// Put the choice into effect: remember the home, copy first if that is the choice,
    /// and RE-PLAN so nothing on the next screen describes a home the app left behind.
    fn apply_choice(&mut self, kind: CardKind) {
        self.notice = None;
        let Some(place) = self.place.clone() else { return };
        let choice = firstrun::Choice { kind, include_key: self.adopt_key };
        let home = choice.home(&place);
        let cwd = std::env::current_dir().ok();
        if let Err(message) =
            self.context.app_prefs.set_home(&home.to_string_lossy(), cwd.as_deref())
        {
            self.notice = Some(message);
            return;
        }
        self.save_prefs();
        // A copy runs first and on its own thread. The pack is installed into the copy
        // when Start is pressed, which is the same rule a fresh home follows: ONE place
        // decides "this home has no pack yet".
        if kind == CardKind::CopyExisting {
            if let Some(existing) = place.existing.as_ref() {
                let adoption = vn_shell_core::adopt::plan(&existing.path, &home);
                self.run_adopt(adoption);
            }
        }
        self.replan();
    }

    /// Rebuild everything the home choice decided, and say so if it cannot be.
    fn replan(&mut self) {
        match vn_shell_runtime::view::view(
            &self.context.options,
            self.context.app_prefs.home.as_deref(),
        ) {
            Ok(view) => {
                self.sizes = view.paths.iter().map(Row::size).collect();
                self.context.plan = view.plan;
                self.context.paths = view.paths;
                self.context.profiles = view.profiles;
                self.context.prefs = view.prefs;
                self.context.key_state = view.key_state;
                // The profile's own answer is re-read on the next tick rather than
                // assumed: an install may be what changed it.
                self.pack_checked = None;
            }
            Err(message) => self.notice = Some(message),
        }
    }

    /// Whether the home in use has this pack in it. One file, read on a click.
    fn pack_missing(&self) -> bool {
        self.context
            .plan
            .home_path()
            .map(|home| {
                !vn_shell_core::profile::bundles(home, vn_shell_core::launch::PROFILE)
                    .map(|bundles| vn_shell_core::profile::has_pack(&bundles))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// What the pack row says, from the profile the harness will load.
    fn pack_state(&self) -> PackState {
        match self.context.plan.home_path() {
            Some(home) => {
                match vn_shell_core::profile::bundles(home, vn_shell_core::launch::PROFILE) {
                    Some(bundles) if vn_shell_core::profile::has_pack(&bundles) => {
                        PackState::Installed(bundles.len())
                    }
                    Some(bundles) => PackState::Bare(bundles.len()),
                    None => PackState::Bare(0),
                }
            }
            None => PackState::Bare(0),
        }
    }

    fn palette(&self) -> Palette {
        Palette::for_theme(self.context.prefs.palette())
    }
}

impl Shell {
    /// Re-read the profile's own answer to "is this pack installed here".
    ///
    /// Two triggers, and both are cheap: a two-second tick, and a setup run that
    /// has just FINISHED - which is the one moment the answer can change. Without
    /// the second one the row would go on saying "the pack is missing" for up to
    /// two seconds after a successful install, which reads as a failed install.
    fn refresh_pack_state(&mut self) {
        let running = self.context.setup.is_running();
        let just_finished = self.setup_was_running && !running;
        self.setup_was_running = running;
        let stale = self
            .pack_checked
            .map(|at| at.elapsed() > Duration::from_secs(2))
            .unwrap_or(true);
        if stale || just_finished {
            self.pack_note = vn_shell_runtime::missing_pack_note(
                self.context.plan.home_path(),
                vn_shell_core::launch::PROFILE,
            );
            self.pack_checked = Some(std::time::Instant::now());
        }
    }

    fn status(&self) -> Status {
        self.context.supervisor.status()
    }

    /// Start the harness - and, when the chosen home has no pack in it yet, install
    /// that FIRST.
    ///
    /// **One press to a working interface.** The installer re-links the profile, which
    /// must never happen under a live harness, and at this moment nothing is running -
    /// which is exactly the window it needs. A home whose profile lists no bundle of
    /// this pack starts the BARE harness (no right bar, no editor, no themes), a state
    /// that reads as a broken app; folding the install into Start is what makes "choose
    /// a home, press Start" enough.
    fn start(&mut self) {
        self.notice = None;
        if self.pack_missing()
            && self.context.setup_entries.is_some()
            && !self.context.setup.is_running()
        {
            self.next = Some(Next::Start);
            self.run_setup(SetupKind::Install);
            return;
        }
        self.opened_for = None;
        self.last_stop = None;
        self.surface = None;
        let remembered = self.context.app_prefs.home.clone();
        if let Err(error) =
            self.context.supervisor.start(self.context.options.clone(), remembered)
        {
            self.notice = Some(error);
        }
    }

    /// Open the harness in the chosen browser, WITH the launch token.
    ///
    /// The one place in the panel that hands the token to another process, and it does
    /// it the only way the security rules allow: the URL leaves as a single argv
    /// element of a program this app found, never through a shell and never onto a
    /// disk. The panel's own address row keeps drawing the token-less form.
    fn open_tab(&mut self) {
        self.notice = None;
        let Some(url) = self.status().navigate_url().map(str::to_string) else {
            self.notice = Some(
                "there is no address to open yet - press Start and wait for the harness to be ready"
                    .to_string(),
            );
            return;
        };
        match browser::launch(&self.context.browser, &url) {
            Ok(label) => self.surface = Some(format!("{label} (a new tab)")),
            Err(error) => {
                self.surface = None;
                self.notice = Some(format!(
                    "{error}. Choose another browser in the Surface row and press Open tab again."
                ));
            }
        }
    }

    /// Remember a browser, and say so if the preferences file could not be written.
    ///
    /// The choice takes effect on the NEXT Start, because the tab is opened once the
    /// ready line arrives - which is the same rule the home choice follows, and the
    /// panel says so in both places rather than pretending otherwise.
    fn choose_browser(&mut self, id: &str) {
        if !self.context.app_prefs.set_browser(id) {
            self.notice = Some(format!("'{id}' is not a browser this build knows"));
            return;
        }
        self.context.browser = browser::resolve(self.context.app_prefs.browser.as_deref(), &self.context.browsers);
        self.save_prefs();
    }

    /// Bring the home question back.
    ///
    /// This is the way back to the first-run screen, and it is the ONLY home control
    /// now: the four buttons that used to sit beside Start (`Use …`, `Adopt …`, `Use my
    /// own home`, `Forget it`) were four answers to one question, asked in a place where
    /// the question was not visible. Clearing the remembered home puts the question back
    /// in front of the person, with the machine's installation and this app's own root
    /// both on offer again.
    fn change_home(&mut self) {
        self.context.app_prefs.clear_home();
        self.save_prefs();
        self.notice = None;
        self.pack_checked = None;
        // Re-surveyed, because a copy or an install may have changed what the cards
        // should say.
        self.place = self.context.plan.app_root().map(|root| {
            Where::survey(vn_shell_core::home::existing_default_home().as_deref(), root)
        });
        self.replan();
    }

    fn save_prefs(&mut self) {
        let Some(root) = self.context.prefs_root.clone() else {
            self.notice = Some(
                "there is nowhere to remember that: this app could not create its own root"
                    .to_string(),
            );
            return;
        };
        if let Err(error) = self.context.app_prefs.save(&root) {
            self.notice = Some(error);
        }
    }

    fn stop(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        let shell = Arc::clone(&self.context.supervisor);
        let outcome = Arc::new(Mutex::new(None));
        let slot = Arc::clone(&outcome);
        // Stop blocks until the tree is down and the port has been CHECKED, which
        // is up to a few seconds. On a thread, so the window keeps drawing and can
        // say what it is waiting for.
        std::thread::spawn(move || {
            let report = shell.stop();
            if let Ok(mut slot) = slot.lock() {
                *slot = Some(report);
            }
        });
        self.last_stop = None;
        self.stop_outcome = Some(outcome);
    }

    /// Fold this frame's window geometry into the shared record.
    fn observe(&self, ctx: &egui::Context) {
        let info = ctx.input(|input| input.viewport().clone());
        let Some(inner) = info.inner_rect else {
            return;
        };
        let reading = WindowState {
            width: inner.width() as f64,
            height: inner.height() as f64,
            x: info.outer_rect.map(|rect| rect.min.x as f64),
            y: info.outer_rect.map(|rect| rect.min.y as f64),
            maximized: info.maximized.unwrap_or(false),
        };
        if let Ok(mut slot) = self.context.geometry.lock() {
            *slot = slot.merge(&reading);
        }
    }

    fn theme(&self, ctx: &egui::Context) {
        let palette = Palette::for_theme(self.context.prefs.palette());
        let mut visuals = if self.context.prefs.palette() == "light" {
            egui::Visuals::light()
        } else {
            egui::Visuals::dark()
        };
        visuals.panel_fill = palette.background;
        visuals.window_fill = palette.background;
        visuals.selection.bg_fill = palette.accent.gamma_multiply(0.35);
        ctx.set_visuals(visuals);
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
//
// egui 0.36 splits an application in two: `logic`, which may not draw and is also
// called while the window is hidden, and `ui`, which is handed the root `Ui` and
// draws into it. Panels are therefore shown INSIDE that `Ui`
// (`egui::Panel::top(...).show(ui, …)`) rather than against the context, which is
// the shape this file is written to.
impl eframe::App for Shell {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // A stop that was started on a thread: pick up its answer when it lands.
        if let Some(outcome) = self
            .stop_outcome
            .as_ref()
            .and_then(|slot| slot.lock().ok().and_then(|slot| slot.clone()))
        {
            self.last_stop = Some(outcome);
            self.stopping = false;
            self.stop_outcome = None;
            // ...and if the reader asked "install the pack here" while the harness was
            // up, this is the moment it may run: the installer re-links the profile,
            // which it must not do under a live harness.
            if self.next == Some(Next::InstallPack) {
                self.next = None;
                self.run_setup(SetupKind::Install);
            }
        }

        self.theme(ctx);
        self.observe(ctx);
        // A step that was asked for while another was running. The "was" is read BEFORE
        // the refresh, because the refresh is what consumes the transition.
        let setup_was = self.context.setup.is_running();
        let adopt_was = self.context.adopt.is_running();
        self.refresh_pack_state();

        // An install or an uninstall just finished: the homes changed under us - a
        // profile exists now that did not, and a pack may have appeared in it.
        if setup_was && !self.context.setup.is_running() {
            let finished_well = self.context.setup.status().exit == Some(0);
            self.replan();
            match self.next.take() {
                // A Start that was waiting for the pack. It only goes ahead if the
                // install WORKED: starting a bare harness because the installer failed
                // would hide the failure behind a window that looks merely empty.
                Some(Next::Start) if finished_well => self.start(),
                Some(Next::Start) => {
                    self.notice = Some(
                        "the pack could not be installed, so the harness was not started - the log has the installer's own output".to_string(),
                    );
                }
                _ => {}
            }
        }
        // A copy just finished: the home it copied INTO is the one in use, so the
        // location map and the key state are re-read rather than assumed.
        if adopt_was && !self.context.adopt.is_running() {
            self.replan();
        }

        // The browser tab is opened once the ready line names a loopback URL - the
        // same hand-off `scripts/run-web` makes, with the URL as ONE argv element,
        // through a program this app found rather than through a shell. One tab per
        // INSTANCE (keyed on the pid), not one per frame.
        let status = self.status();
        if status.phase == Phase::Running && self.opened_for != status.pid {
            if let Some(url) = status.navigate_url() {
                match browser::launch(&self.context.browser, url) {
                    Ok(label) => self.surface = Some(format!("{label} (a new tab)")),
                    Err(error) => {
                        self.surface = None;
                        self.notice = Some(format!(
                            "{error}. Press Open tab to try again, or choose another browser in the Surface row."
                        ));
                    }
                }
                self.opened_for = status.pid;
            }
        }

        // Poll: the supervisor's state changes on its own thread.
        ctx.request_repaint_after(POLL);
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // THE CHOICE COMES FIRST, and while it is unmade it IS the window: no header,
        // no log, no rows - one question and the cards that answer it.
        if self.needs_setup() {
            self.setup_screen(ui);
            return;
        }
        let status = self.status();
        self.header(ui, &status);
        self.log_panel(ui);
        self.body(ui, &status);
    }
}

impl Shell {
    /// The whole bar: what the harness is doing, and the three things that can be done
    /// about it. One line, and everything that is neither a state nor an action is in
    /// `Details` below.
    fn header(&mut self, ui: &mut egui::Ui, status: &Status) {
        egui::Panel::top("header").show(ui, |ui| {
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.label(RichText::new("vncode").strong().size(18.0));
                ui.add_space(8.0);
                let (colour, text) = phase_badge(status.phase);
                ui.label(RichText::new(format!("● {text}")).color(colour));
                ui.add_space(12.0);

                let live = status.phase.is_live();
                let busy = self.context.setup.is_running() || self.context.adopt.is_running();
                ui.add_enabled_ui(!live && !self.stopping && !busy, |ui| {
                    let label = if busy { "Working…" } else { "Start" };
                    if ui
                        .button(label)
                        .on_hover_text(
                            "starts the pinned harness - and installs this pack first if this home has none",
                        )
                        .clicked()
                    {
                        self.start();
                    }
                });
                ui.add_enabled_ui(live && !self.stopping, |ui| {
                    let label = if self.stopping { "Stopping…" } else { "Stop" };
                    if ui.button(label).clicked() {
                        self.stop();
                    }
                });
                // THE BUTTON THAT CARRIES THE TOKEN. The panel draws the URL without
                // its query, because that URL is a credential; this opens the one with
                // it, in the chosen browser, as one argv element. It is also the way
                // back in after a tab is closed by accident.
                let running = status.phase == Phase::Running;
                let open = ui
                    .add_enabled(running, egui::Button::new("Open tab"))
                    .on_hover_text(
                        "opens the harness in the chosen browser, with the launch token the panel never draws",
                    );
                if open.clicked() {
                    self.open_tab();
                }
                if !running {
                    open.on_disabled_hover_text(
                        "the harness is not running - press Start, and Open tab lights up",
                    );
                }

                if let Some(uptime) = status.uptime_label() {
                    ui.add_space(12.0);
                    ui.label(RichText::new(format!("up {uptime}")).weak());
                }
            });
            ui.add_space(6.0);
        });
    }

    /// Ask the installer to run, and say why if it cannot.
    ///
    /// It is given the SAME composed environment and the same `-DshHome` the harness
    /// will be given: an installer that defaulted to the harness's own home would put
    /// this pack into a profile the app is not running, which is the one way a
    /// working Install button can look like a broken one.
    fn run_setup(&mut self, kind: SetupKind) {
        self.notice = None;
        let Some(entries) = self.context.setup_entries.clone() else {
            self.notice = Some(
                "there is no installer beside this app - scripts/setup/ is missing, so this build can only supervise a pack that is already installed".to_string(),
            );
            return;
        };
        let entry = entries.for_kind(kind).to_path_buf();
        let (environment, home_arguments) = self.installer_plan();
        if let Err(message) = self.context.setup.start(kind, &entry, &[], &environment, &home_arguments)
        {
            self.notice = Some(message);
        }
    }

    /// What the installer is given, from the plan the panel is already drawing.
    fn installer_plan(&self) -> (vn_shell_runtime::ChildEnv, Vec<std::ffi::OsString>) {
        (
            vn_shell_runtime::env::for_plan(&self.context.plan),
            vn_shell_runtime::env::dsh_home_arguments(&self.context.plan.home),
        )
    }

    /// Copy the durable things out of the home this app did not create.
    fn run_adopt(&mut self, adoption: vn_shell_core::adopt::Adoption) {
        self.notice = None;
        self.adopt_note = None;
        if let Err(message) = self.context.adopt.start(adoption, self.adopt_key) {
            self.adopt_note = Some(message);
        }
    }

    /// The panel, after the home is settled: what is happening, four facts, and
    /// everything diagnostic one disclosure away.
    fn body(&mut self, ui: &mut egui::Ui, status: &Status) {
        egui::CentralPanel::default().show(ui, |ui| {
            if let Some(notice) = self.notice.clone() {
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new("! ").color(WARN));
                    ui.label(notice);
                });
                ui.separator();
            }
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.add_space(6.0);
                self.summary(ui, status);
                ui.add_space(10.0);
                self.details(ui, status);
            });
        });
    }

    /// **The four rows.** Each is a fact about the home in use, and the ones that can be
    /// acted on carry their own action: `home` asks the question again, `pack` installs
    /// this pack where the harness will read it, `browser` chooses what opens the tab.
    fn summary(&mut self, ui: &mut egui::Ui, status: &Status) {
        let live = status.phase.is_live();
        let busy = self.context.setup.is_running() || self.context.adopt.is_running();
        egui::Grid::new("summary").num_columns(2).spacing([18.0, 8.0]).show(ui, |ui| {
            // --- home ---------------------------------------------------------------
            ui.label(RichText::new("home").strong());
            let (path, why) = self.context.plan.home.row();
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new(&path).monospace());
                ui.label(RichText::new(format!("· {why}")).weak());
                if self.context.plan.home_created() {
                    ui.label(RichText::new("· created by this app").weak());
                }
                // The way back to the question, and the ONLY home control the panel has:
                // the four buttons that used to sit beside Start were four answers to one
                // question, asked where the answer could not be seen.
                if ui
                    .add_enabled(!live && !busy, egui::Button::new("Change"))
                    .on_hover_text(format!(
                        "ask where your sessions, skills and key should live ({})",
                        shorten(std::path::Path::new(&path))
                    ))
                    .clicked()
                {
                    self.change_home();
                }
            });
            ui.end_row();

            // --- pack ---------------------------------------------------------------
            ui.label(RichText::new("pack").strong());
            ui.horizontal_wrapped(|ui| {
                match self.pack_state() {
                    PackState::Installed(bundles) => {
                        ui.label(RichText::new(format!("installed · {bundles} bundles")).color(OK));
                    }
                    PackState::Bare(0) => {
                        ui.label(RichText::new("not installed here yet").color(WARN));
                    }
                    PackState::Bare(bundles) => {
                        ui.label(
                            RichText::new(format!(
                                "this profile lists {bundles} bundles, none of them this pack"
                            ))
                            .color(WARN),
                        );
                    }
                }
                if self.pack_missing() && self.context.setup_entries.is_some() {
                    if live {
                        if ui
                            .add_enabled(!busy && !self.stopping, egui::Button::new("Stop and install"))
                            .on_hover_text(
                                "the installer re-links the profile, so the harness has to stop first - this does both",
                            )
                            .clicked()
                        {
                            self.next = Some(Next::InstallPack);
                            self.stop();
                        }
                    } else if ui
                        .add_enabled(!busy, egui::Button::new("Install pack here"))
                        .on_hover_text("runs scripts/setup/install.* with this home's -DshHome")
                        .clicked()
                    {
                        self.run_setup(SetupKind::Install);
                    }
                    ui.label(RichText::new("· Start installs it for you too").weak());
                } else if self.context.setup_entries.is_none() {
                    ui.label(RichText::new("no installer beside this app").weak());
                }
            });
            ui.end_row();

            // --- key ----------------------------------------------------------------
            ui.label(RichText::new("DeepSeek key").strong());
            ui.horizontal_wrapped(|ui| {
                match self.context.key_state.source() {
                    // The layer's NAME, never a value - see `keystate`.
                    Some(source) => {
                        ui.label(RichText::new(format!("found in {}", source.label())).color(OK));
                    }
                    None => {
                        ui.label(RichText::new("not found").color(WARN));
                        ui.label(RichText::new("· add one in the harness's Settings > Models").weak());
                        // The one useful hint while it is missing: the OTHER home has one,
                        // and `Change` is where it can be copied from.
                        if self
                            .place
                            .as_ref()
                            .and_then(|place| place.existing.as_ref().map(|existing| existing.key))
                            == Some(true)
                        {
                            ui.label(
                                RichText::new("· the home on this machine has one - Change copies it")
                                    .weak(),
                            );
                        }
                    }
                };
            });
            ui.end_row();

            // --- browser ------------------------------------------------------------
            ui.label(RichText::new("browser").strong());
            ui.horizontal_wrapped(|ui| {
                let current = self.context.browser.id;
                let mut chosen = current;
                egui::ComboBox::from_id_salt("browser")
                    .selected_text(self.context.browser.label)
                    .show_ui(ui, |ui| {
                        for browser in &self.context.browsers {
                            if ui.selectable_label(browser.id == current, browser.label).clicked() {
                                chosen = browser.id;
                            }
                        }
                    });
                if chosen != current {
                    self.choose_browser(chosen);
                }
                match &self.surface {
                    Some(what) => ui.label(RichText::new(format!("· opened in {what}")).weak()),
                    None => ui.label(
                        RichText::new(match status.phase {
                            Phase::Running => "· Open tab opens a new one",
                            _ => "· a new tab when Start runs",
                        })
                        .weak(),
                    ),
                };
            });
            ui.end_row();
        });
    }

    /// Everything the panel knows that is not one of the four rows, folded away.
    ///
    /// Nothing was deleted to make the panel small: the pin, the runtime, the composed
    /// environment, the pid, the location map with its sizes, the refusals and the notes
    /// are all here - and the title carries a badge when a path was refused, because a
    /// refusal must never be the thing that is hidden.
    fn details(&mut self, ui: &mut egui::Ui, status: &Status) {
        let refused = self.context.plan.home.refused.len();
        let title = if refused > 0 {
            format!("Details · {refused} refused path(s)")
        } else {
            "Details".to_string()
        };
        egui::CollapsingHeader::new(title)
            .default_open(self.details_open)
            .show(ui, |ui| {
                self.details_open = true;
                self.status_table(ui, status);
                ui.add_space(8.0);
                // The pack's maintenance pair. It lives here rather than beside Start:
                // uninstall is not a twice-a-day action, and the install the panel OFFERS
                // is on the pack row above.
                self.setup_buttons(ui, status);
                ui.add_space(10.0);
                self.paths_table(ui);
                ui.add_space(10.0);
                self.provider_table(ui, status);
                if !self.context.plan.notes.is_empty() {
                    ui.add_space(10.0);
                    ui.separator();
                    for note in self.context.plan.notes.clone() {
                        ui.label(RichText::new(format!("note: {note}")).weak());
                    }
                }
                for refusal in self.context.plan.home.refused.clone() {
                    ui.label(RichText::new(refusal.line()).weak());
                }
                if let Some(note) = self.adopt_note.clone() {
                    ui.label(RichText::new(note).color(WARN));
                }
            });
    }

    /// Install and uninstall, with the same rule the header used to carry: neither may
    /// run while the harness is live, because the installer re-links the profile under it.
    fn setup_buttons(&mut self, ui: &mut egui::Ui, status: &Status) {
        let setup = self.context.setup.status();
        let busy = setup.running || self.context.adopt.is_running();
        let live = status.phase.is_live();
        let can = can_run_setup(self.context.setup_entries.is_some(), live, busy);
        ui.horizontal_wrapped(|ui| {
            ui.add_enabled_ui(can, |ui| {
                if ui.button("Install pack").clicked() {
                    self.run_setup(SetupKind::Install);
                }
            });
            ui.add_enabled_ui(can, |ui| {
                if ui.button("Uninstall pack").clicked() {
                    self.run_setup(SetupKind::Uninstall);
                }
            });
            if self.context.setup_entries.is_none() {
                ui.label(RichText::new("no installer beside this app").weak());
            } else if live {
                ui.label(RichText::new("stop the harness first").weak());
            } else if busy {
                ui.label(
                    RichText::new(format!(
                        "{}ing…",
                        setup.kind.map(SetupKind::label).unwrap_or("work")
                    ))
                    .weak(),
                );
            }
        });
    }

    /// The rows that did not earn a place in the summary: what this app knows, and
    /// nothing it can be asked to do.
    fn status_table(&mut self, ui: &mut egui::Ui, status: &Status) {
        egui::Grid::new("status").num_columns(2).spacing([18.0, 6.0]).show(ui, |ui| {
            ui.label(RichText::new("pin").strong());
            ui.label(format!("{} (from .dsh-version.json)", self.context.plan.version));
            ui.end_row();

            ui.label(RichText::new("runtime").strong());
            ui.label(self.context.plan.runtime_line());
            ui.end_row();

            ui.label(RichText::new("vncode root").strong());
            match self.context.plan.app_root() {
                Some(root) => ui.label(
                    RichText::new(format!(
                        "{}  ({})",
                        root.display(),
                        self.context.plan.home.app_root_origin_label()
                    ))
                    .monospace(),
                ),
                None => ui.label(RichText::new("none could be written").color(WARN)),
            };
            ui.end_row();

            ui.label(RichText::new("harness env").strong());
            ui.label(RichText::new(self.context.plan.env_line()).monospace().weak());
            ui.end_row();

            ui.label(RichText::new("profile").strong());
            ui.label(profile_line(&self.context.profiles));
            ui.end_row();

            ui.label(RichText::new("last setup").strong());
            let setup = self.context.setup.status();
            match (setup.running, setup.exit) {
                (true, _) => ui.label(
                    RichText::new(format!(
                        "{}ing…",
                        setup.kind.map(SetupKind::label).unwrap_or("work")
                    ))
                    .color(WARN),
                ),
                (false, Some(0)) => ui.label(
                    RichText::new(format!(
                        "{} finished",
                        setup.kind.map(SetupKind::label).unwrap_or("setup")
                    ))
                    .color(OK),
                ),
                (false, Some(code)) => ui.label(
                    RichText::new(format!(
                        "{} failed (exit {code}) - see the log",
                        setup.kind.map(SetupKind::label).unwrap_or("setup")
                    ))
                    .color(WARN),
                ),
                (false, None) => ui.label(RichText::new("—").weak()),
            };
            ui.end_row();

            ui.label(RichText::new("address").strong());
            ui.horizontal_wrapped(|ui| {
                match status.public_url() {
                    // The displayable URL: no query, therefore no launch token.
                    Some(url) => {
                        ui.label(RichText::new(url).monospace());
                        ui.label(
                            RichText::new("· the launch token is added by Open tab, never drawn")
                                .weak(),
                        );
                    }
                    None => {
                        ui.label(
                            RichText::new(match status.port {
                                Some(port) => format!("127.0.0.1:{port} (not listening yet)"),
                                None => "not chosen yet".to_string(),
                            })
                            .weak(),
                        );
                    }
                };
            });
            ui.end_row();

            ui.label(RichText::new("process").strong());
            match status.pid {
                Some(pid) => ui.label(format!("pid {pid}")),
                None => ui.label(RichText::new("nothing running").weak()),
            };
            ui.end_row();

            ui.label(RichText::new("last stop").strong());
            match &self.last_stop {
                Some(outcome) if outcome.port_free => {
                    ui.label(RichText::new("the port is free again").color(OK))
                }
                Some(outcome) => ui.label(
                    RichText::new(format!(
                        "something STILL holds port {}",
                        outcome.port.map(|port| port.to_string()).unwrap_or_else(|| "?".into())
                    ))
                    .color(WARN),
                ),
                None => ui.label(RichText::new("—").weak()),
            };
            ui.end_row();
        });
    }

    fn paths_table(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("where things live").strong());
            if ui.small_button("measure").clicked() {
                self.sizes = self.context.paths.iter().map(Row::size).collect();
            }
            ui.label(RichText::new("(reveal opens the folder or selects the file)").weak());
        });
        egui::Grid::new("paths").num_columns(4).spacing([18.0, 4.0]).striped(true).show(ui, |ui| {
            for (index, row) in self.context.paths.iter().enumerate() {
                ui.label(match row.kind {
                    Kind::Home | Kind::Workspace => RichText::new(row.label).strong(),
                    _ => RichText::new(row.label),
                });
                match &row.path {
                    Some(path) => ui.label(RichText::new(path.display().to_string()).monospace()),
                    None => ui.label(RichText::new("unknown").weak()),
                };
                let size = self.sizes.get(index).copied().flatten();
                ui.label(
                    RichText::new(match (row.state(), size) {
                        ("present", Some(bytes)) => format!("present · {}", human(bytes)),
                        (state, _) => state.to_string(),
                    })
                    .weak(),
                );
                if let Some(path) = row.path.clone() {
                    ui.add_enabled_ui(path.exists(), |ui| {
                        if ui.small_button("reveal").clicked() {
                            urlpolicy::reveal(&path, path.is_dir());
                        }
                    });
                } else {
                    ui.label("");
                }
                ui.end_row();
            }
        });
        ui.label(
            RichText::new(self.context.paths.first().map(|row| row.note.clone()).unwrap_or_default())
                .weak(),
        );
    }

    fn provider_table(&mut self, ui: &mut egui::Ui, status: &Status) {
        ui.label(RichText::new("model provider").strong());
        egui::Grid::new("provider").num_columns(2).spacing([18.0, 6.0]).show(ui, |ui| {
            ui.label("provider");
            ui.horizontal(|ui| {
                // ONE entry today, and deliberately a chooser: Ollama becomes a
                // second entry here and not a new page. Read-only while a harness
                // is live, because the harness reads its route at boot.
                ui.add_enabled_ui(false, |ui| {
                    let mut selected = "deepseek-official";
                    egui::ComboBox::from_id_salt("provider")
                        .selected_text("DeepSeek (official)")
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut selected, "deepseek-official", "DeepSeek (official)");
                        });
                });
                ui.label(RichText::new("Ollama: not yet - planned, see docs/PLAN-egui-shell.md").weak());
            });
            ui.end_row();
            ui.label("route");
            ui.label("the profile's own cordis.patch.yml decides it; this shell only names it");
            ui.end_row();
            if status.phase.is_live() {
                ui.label("");
                ui.label(RichText::new("read-only while a harness is running").weak());
                ui.end_row();
            }
        });
    }

    fn log_panel(&mut self, ui: &mut egui::Ui) {
        // A FULL-WIDTH panel of a FIXED thickness, with a drag seam.
        //
        // egui panels auto-shrink to their content, so the first version collapsed
        // to nothing while the log was empty and grew a line at a time - which reads
        // as "there is no log panel" and leaves no seam to grab. `min_size` keeps
        // the panel where the reader put it, and `auto_shrink([false, false])` on
        // the scroll area inside stops its content from deciding the height OR the
        // width.
        egui::Panel::bottom("log")
            .resizable(true)
            .default_size(240.0)
            .min_size(120.0)
            .max_size(720.0)
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("log").strong());
                    ui.label(
                        RichText::new(
                            "(the harness and the installer, token redacted on the way in)",
                        )
                        .weak(),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(RichText::new("drag this bar to resize").weak());
                    });
                });
                // ONE transcript, drawn from the console both writers write to, so
                // an install's output and the harness's output share a cursor.
                let lines = self.context.console.tail(LOG_LINES);
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        if lines.is_empty() {
                            ui.label(
                                RichText::new("nothing yet - press Start, or Install pack").weak(),
                            );
                        }
                        for line in lines {
                            ui.label(RichText::new(line).monospace().size(12.0));
                        }
                    });
            });
    }
}

/// Whether the Install and Uninstall buttons may be pressed.
///
/// Three conditions, and each is a fact rather than a preference:
///
/// - an entry point was FOUND beside this app (a folder with only `app/` in it has
///   nothing to run, and the panel says so instead of offering a dead button);
/// - no harness is LIVE - installing while one is running would re-link the profile
///   under a process that has already read it;
/// - no setup run is already in flight, because two installers at once would race
///   over the same profile.
fn can_run_setup(has_entry_points: bool, harness_live: bool, setup_busy: bool) -> bool {
    has_entry_points && !harness_live && !setup_busy
}

fn phase_badge(phase: Phase) -> (Color32, &'static str) {    match phase {
        Phase::Idle => (Color32::from_rgb(0x90, 0x94, 0x9a), "stopped"),
        Phase::Starting => (Color32::from_rgb(0xff, 0xb0, 0x00), "starting"),
        Phase::Running => (Color32::from_rgb(0x4c, 0xaf, 0x50), "running"),
        Phase::Stopping => (Color32::from_rgb(0xff, 0xb0, 0x00), "stopping"),
        Phase::Stopped => (Color32::from_rgb(0x90, 0x94, 0x9a), "stopped"),
        Phase::Failed => (Color32::from_rgb(0xe5, 0x39, 0x35), "failed"),
    }
}

fn profile_line(profiles: &[String]) -> String {
    if profiles.is_empty() {
        "none found under this home yet".to_string()
    } else {
        profiles.join(", ")
    }
}

/// The one line about this app's own root that the first-run screen owes a reader:
/// where a fresh home would go, and why the root is where it is.
///
/// It is on that screen because "Create it here" is a card about a PATH, and a card that
/// does not say which path it means is asking somebody to guess.
fn root_line(plan: &Plan) -> String {
    match plan.app_root() {
        Some(root) => format!(
            "this app's own root: {} ({})",
            root.display(),
            plan.home.app_root_origin_label()
        ),
        None => "this app could not create a root of its own - the log names every path it tried".to_string(),
    }
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------
/// A path a person reads at a glance: its last two components.
///
/// The panel is 700-odd points wide and a home path is much longer than that, so the
/// button says `me/.dsh` while the row above it - and the hover text - carry the whole
/// path. Nothing here is used to OPEN anything; it is a label.
fn shorten(path: &std::path::Path) -> String {
    let name = path.file_name().map(|name| name.to_string_lossy().to_string());
    let parent = path.parent().and_then(|parent| parent.file_name());
    match (parent, name) {
        (Some(parent), Some(name)) => format!("{}/{name}", parent.to_string_lossy()),
        (None, Some(name)) => name,
        _ => path.display().to_string(),
    }
}

/// Build the viewport this window should open with, from a remembered record.
///
/// The record's RULES live in `windowstate` and are driven by `cargo test`; this is
/// only the translation into egui's builder. The POSITION is deliberately not
/// restored here: this toolkit cannot ask which monitors exist before the window is
/// built, and a window restored onto a display that is no longer plugged in is one
/// nobody can see - a worse outcome than a centred window. Size and the maximized
/// flag are restored, and the recorded position is still written back.
pub fn viewport(remembered: &WindowState, title: &str) -> egui::ViewportBuilder {
    egui::ViewportBuilder::default()
        .with_title(title)
        .with_inner_size([remembered.width as f32, remembered.height as f32])
        .with_min_inner_size([
            windowstate::MIN_WIDTH as f32,
            windowstate::MIN_HEIGHT as f32,
        ])
        .with_maximized(remembered.maximized)
        .with_resizable(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_path_is_shortened_to_the_two_parts_a_person_reads() {
        assert_eq!(shorten(std::path::Path::new("/home/me/.dsh")), "me/.dsh");
        if cfg!(windows) {
            assert_eq!(shorten(std::path::Path::new("C:\\Users\\me\\.dsh")), "me/.dsh");
        }
        // A path with nothing to shorten is returned whole rather than emptied.
        assert_eq!(shorten(std::path::Path::new("/")), "/");
    }

    #[test]
    fn the_install_buttons_are_enabled_only_when_they_can_work() {
        // Idle with an installer beside the app: the one state where a press means
        // what it says.
        assert!(can_run_setup(true, false, false));
        // A harness is running: install would re-link the profile under it.
        assert!(!can_run_setup(true, true, false));
        // One setup run at a time.
        assert!(!can_run_setup(true, false, true));
        // Nothing to run (a folder carrying only app/).
        assert!(!can_run_setup(false, false, false));
        assert!(!can_run_setup(false, true, true));
    }

    #[test]
    fn the_page_theme_becomes_the_native_palette() {
        assert_eq!(Palette::for_theme("hacker").accent, Color32::from_rgb(0x00, 0xff, 0x41));
        assert_eq!(Palette::for_theme("light").background, Color32::from_rgb(0xf7, 0xf7, 0xf5));
        // An unknown or missing theme is readable rather than invisible.
        let fallback = Palette::for_theme("something-new");
        assert_eq!(fallback, Palette::for_theme("dark"));
        assert_ne!(fallback.background, Color32::TRANSPARENT);
    }

    #[test]
    fn the_browser_choice_is_the_one_the_panel_draws_and_it_is_never_a_pane() {
        // There is no `embed` to offer: this app draws no web view, and the whole
        // surface is a browser it found. The row that used to be a destination
        // switch is now a chooser over the detected browsers.
        let detected = vec![
            Browser {
                id: "chrome",
                label: "Google Chrome",
                family: browser::Family::Chromium,
                program: Some(std::path::PathBuf::from("chrome")),
            },
            Browser::default_opener(),
        ];
        assert_eq!(browser::resolve(Some("chrome"), &detected).label, "Google Chrome");
        assert_eq!(browser::resolve(Some("firefox"), &detected).id, "chrome");
        assert!(detected.last().unwrap().is_default());
    }

    #[test]
    fn the_viewport_restores_size_and_maximized_and_never_invents_a_position() {
        let remembered = WindowState {
            width: 1200.0,
            height: 800.0,
            x: Some(4000.0),
            y: Some(2000.0),
            maximized: true,
        };
        let builder = viewport(&remembered, "vncode");
        // The builder is opaque, so this asserts what CAN be read back: the size
        // rule lives in `windowstate`'s own tests, and the position is not passed
        // at all - see this function's doc comment.
        assert_eq!(builder.inner_size, Some(egui::vec2(1200.0, 800.0)));
        assert_eq!(builder.maximized, Some(true));
        assert_eq!(builder.title.as_deref(), Some("vncode"));
    }

    #[test]
    fn a_profile_list_is_never_an_empty_sentence() {
        assert!(profile_line(&[]).contains("none found"));
        assert_eq!(profile_line(&["desktop".into(), "web".into()]), "desktop, web");
    }
}
