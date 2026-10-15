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

// The hand-off cluster below - `start_hand_off`, `finish_hand_off`, `confined_hint` and the two
// fields they share - is a BUILD-conditional path. A build WITH the pane starts no browser, so
// nothing in that build's UI reaches them; a build WITHOUT one has no other surface, so they
// are kept rather than deleted. The lint is silenced for that one build and nowhere else: the
// default build, which is what ships, keeps every warning.
#![cfg_attr(feature = "pane", allow(dead_code))]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eframe::egui;
use egui::{Color32, RichText};

use vn_shell_core::appprefs::AppPrefs;
use vn_shell_core::browser::{self, Browser};
use vn_shell_core::firstrun::{self, Card, Kind as CardKind, Where};
use vn_shell_core::home::Origin;
use vn_shell_core::keystate::{self as keystate, KeyState};
use vn_shell_core::options::Options;
use vn_shell_core::prefs::Preferences;
use vn_shell_core::status::{Phase, Status};
use vn_shell_core::windowstate::WindowState;
use vn_shell_core::{appdata, urlpolicy, windowstate};
use vn_shell_paths::{human, Kind, Row};
use vn_shell_runtime::{
    Adopt, Console, EntryPoints, Plan, Setup, SetupKind, StopOutcome, Supervisor,
};

/// Whether THIS build can show the harness inside its own window.
///
/// The binary asks, so that `-Mode embed` is a refusal by name in a build with no engine and
/// a real mode in one that has. The answer travels as a value because `vn-shell-core` is
/// the pure half and has no engine to learn about.
///
/// With the pane it comes from the crate that OWNS the engine rather than from a second
/// `cfg!` here: one place decides whether this build has an engine, and it is not this one.
#[cfg(feature = "pane")]
pub const fn pane_available() -> bool {
    vn_shell_pane::available()
}

/// A build without the pane has no engine, and says so without asking anybody.
#[cfg(not(feature = "pane"))]
pub const fn pane_available() -> bool {
    false
}

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
    /// that did not persist would be a click that lied. The root is the LADDER's -
    /// the same one the window record, the npm cache and the home live in - so a
    /// portable folder, a confined run and an ordinary install all remember the
    /// answer in the place the answer belongs to.
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
    /// **The harness page, and the engine behind it.**
    ///
    /// Compiled only with the `pane` feature. With the feature off this field does not
    /// exist and the browser hand-off is the surface, exactly as before - which is what
    /// keeps the default build's behaviour and its checks unchanged.
    #[cfg(feature = "pane")]
    pane: vn_shell_pane::PanePage,
    /// The home question, surveyed ONCE.
    ///
    /// Surveyed rather than computed per frame, because a survey PROBES - it writes a
    /// file - and a probe per frame would be a write per frame. `None` means this app
    /// has no root of its own, which is a named failure the panel draws rather than a
    /// screen it cannot honour.
    place: Option<Where>,
    /// **A browser hand-off in flight, and where its answer lands.**
    ///
    /// On its own thread because the rungs are WATCHED for up to `browser::SETTLE`
    /// (1.5 s) - a window that stopped drawing for that long would read as a hang. The
    /// panel starts one, keeps drawing, and picks the report up in `logic`.
    hand_off: Option<Arc<Mutex<Option<browser::HandOff>>>>,
    /// A step waiting for the one now running (see [`Next`]).
    next: Option<Next>,
    /// The one disclosure: everything diagnostic, closed by default.
    details_open: bool,
    /// A close request was already refused because a copy or an install was in flight.
    /// The SECOND request is honoured: a window that cannot be closed at all is a
    /// worse bug than a build interrupted on purpose.
    close_refused: bool,
    /// **When the install in flight started, and when it last said anything.**
    ///
    /// Measured on a real machine: the installer's first phase is one `npm exec` that
    /// resolves the harness's whole dependency graph and prints nothing while it does, so
    /// the pack row sat on its last line for a minute, the window was killed 60 seconds
    /// in, and nothing had been written to the profile yet. "installing" with a clock
    /// beside it is the difference between work and a hang; the installer's own line,
    /// when it arrives, moves `installer_last_at`.
    setup_started: Option<std::time::Instant>,
    installer_last: Option<String>,
    installer_last_at: std::time::Instant,
    /// **The key field.** `Some` while it is open, and the value is the person's typing.
    ///
    /// Three rules travel with it, and they are `keystate::write_env_key`'s: the value is
    /// drawn with `password(true)` so it cannot be shoulder-read, it is never written into
    /// a label, a notice, the log or `prefs.json`, and the only thing that comes back out
    /// of a save is the PATH it was written to. It is cleared the moment it is saved or
    /// cancelled.
    key_entry: Option<String>,
    /// The sentence after a save or a refusal - never the value.
    key_note: Option<String>,
    /// Asked once per run: a home with no key gets the field opened for it, because a
    /// fresh portable home starts with no key at all and the alternative is a person
    /// staring at "not found" with no way to fix it in the window they are looking at.
    key_prompted: bool,
}

impl Shell {
    pub fn new(context: ShellContext) -> Shell {
        let sizes = context.paths.iter().map(Row::size).collect();
        let place = context.plan.app_root().map(|root| {
            Where::survey(vn_shell_core::home::existing_default_home().as_deref(), root)
        });
        // `-Mode embed` opens with the harness page in front: the same window and the same
        // two tabs, one of them already showing the instance.
        #[cfg(feature = "pane")]
        let pane = {
            let page = vn_shell_pane::PanePage::new();
            if context.options.mode == Some(vn_shell_core::options::Mode::Embed) {
                page.in_front()
            } else {
                page
            }
        };
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
            #[cfg(feature = "pane")]
            pane,
            hand_off: None,
            close_refused: false,
            setup_started: None,
            installer_last: None,
            installer_last_at: std::time::Instant::now(),
            key_entry: None,
            key_note: None,
            key_prompted: false,
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
                        // NO MARKDOWN, AND NO BACKTICKS: this is drawn with `ui.label`,
                        // so emphasis and code spans reach the reader as punctuation. A
                        // screen of literal asterisks and grave accents is what the
                        // owner saw, and it reads as a broken build.
                        "Pick one. It is remembered, and Change on the next screen brings this back.",
                    )
                    .weak(),
                );
                ui.add_space(12.0);
                for card in &cards {
                    self.setup_card(ui, card, preselected == Some(card.kind));
                    ui.add_space(8.0);
                }
                // THE WAY ON, IN ONE FIXED PLACE. This screen can honestly offer one card
                // and grey out two - measured: the home on this machine is not writable
                // from a confined parent, and the copy has nothing left to bring - and a
                // reader looking at two red paragraphs and a third card has no way to
                // tell that the choice is already made for them. The arrow marks the card
                // the app would take; this button TAKES it.
                if let Some(taken) = place.preselected() {
                    let busy = self.context.setup.is_running() || self.context.adopt.is_running();
                    ui.add_space(2.0);
                    ui.horizontal_wrapped(|ui| {
                        if ui
                            .add_enabled(
                                !busy,
                                egui::Button::new(RichText::new(&taken.continue_label).strong()),
                            )
                            .on_hover_text(format!(
                                "takes the card marked with the arrow above: {} - {}",
                                taken.title,
                                taken.path.display()
                            ))
                            .clicked()
                        {
                            self.apply_choice(taken.kind);
                        }
                        ui.label(
                            RichText::new("· the card marked ▸ above, the one the app suggests")
                                .weak(),
                        );
                    });
                    let taken_count = cards.iter().filter(|card| card.available).count();
                    if taken_count < cards.len() {
                        ui.label(
                            RichText::new(format!(
                                "{taken_count} of {} can be taken on this machine; each card that cannot says why",
                                cards.len()
                            ))
                            .weak(),
                        );
                    }
                    ui.add_space(6.0);
                }
                if !self.notices().is_empty() {
                    ui.add_space(4.0);
                    self.draw_notices(ui);
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
    ///
    /// A card that cannot be taken has its button DISABLED and carries the reason in
    /// words - never a button that would fail, and never a silent grey chip.
    fn setup_card(&mut self, ui: &mut egui::Ui, card: &Card, preselected: bool) {
        let busy = self.context.setup.is_running() || self.context.adopt.is_running();
        ui.group(|ui| {
            ui.horizontal(|ui| {
                if card.available {
                    ui.label(
                        RichText::new(if preselected { "▸" } else { " " })
                            .color(self.palette().accent)
                            .strong(),
                    );
                } else {
                    ui.label(RichText::new("×").color(WARN).strong())
                        .on_hover_text("this one cannot be taken here - the reason is on the card");
                }
                ui.label(RichText::new(&card.title).strong());
                if card.recommended {
                    ui.label(RichText::new("· recommended").color(self.palette().accent));
                }
            });
            // THE ONE LINE THAT DECIDES IT, ALWAYS OPEN: where the card goes and what is
            // there now. The rest of the facts go behind `details`, closed by default -
            // measured: with every fact drawn open, three cards filled the window and
            // pushed each card's own reason and button off the bottom of it.
            ui.label(RichText::new(&card.summary));
            if !card.facts.is_empty() {
                egui::CollapsingHeader::new("details")
                    .id_salt(card.id())
                    .default_open(false)
                    .show(ui, |ui| {
                        for fact in &card.facts {
                            ui.label(RichText::new(fact).weak());
                        }
                    });
            }
            // THE REASON IS NEVER COLLAPSED. It is the answer to "why can I not press
            // this", and a greyed-out button with its explanation one click away is a bug
            // report waiting to happen.
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
                // ONE WORDING PER ACTION, and the card's own is the one that counts: the
                // button here and the one at the foot of the screen take the same card,
                // so they say the same thing. Deciding the label in the drawing code is
                // how the foot of the screen and the card drift apart.
                if ui
                    .add_enabled(card.available && !busy, egui::Button::new(&card.continue_label))
                    .clicked()
                {
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
        // A copy runs first and on its own thread, and the pack follows it into the home
        // it just filled (see the chain in `logic`). ONE place decides "this home has no
        // pack yet", which is why the chain is a decision function rather than a second
        // copy of the rule.
        if kind == CardKind::CopyExisting {
            if let Some(existing) = place.existing.as_ref() {
                let adoption = vn_shell_core::adopt::plan(&existing.path, &home);
                self.run_adopt(adoption);
            }
        }
        self.replan();
    }

    /// **The one place in this app that holds a secret**, and the whole of what it does
    /// with it.
    ///
    /// The value is drawn masked, kept in this struct only while the field is open, handed
    /// to `keystate::write_env_key` - which returns the PATH and never the value - and
    /// cleared on save. What the panel may print is the path: the log line and the note
    /// both name the file, because a transcript is the easiest place to leak a key and the
    /// only safe thing to say about one is where it went.
    fn key_field(&mut self, ui: &mut egui::Ui) {
        if self.key_entry.is_none() {
            if let Some(note) = self.key_note.clone() {
                ui.label(RichText::new(note).weak());
            }
            return;
        }
        let mut value = self.key_entry.clone().unwrap_or_default();
        let mut save = false;
        let mut cancel = false;
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("key").weak());
            ui.add(
                egui::TextEdit::singleline(&mut value)
                    .password(true)
                    .desired_width(300.0)
                    .hint_text("paste the value from the DeepSeek console"),
            );
            save = ui
                .add_enabled(!value.trim().is_empty(), egui::Button::new("Save"))
                .on_hover_text("writes DEEPSEEK_API_KEY into this home's .env")
                .clicked();
            cancel = ui.button("Cancel").clicked();
        });
        let where_line = match self.context.plan.home_path() {
            Some(home) => format!(
                "written to {} as DEEPSEEK_API_KEY - inside this home, so it travels with the folder. It is never read back and never logged",
                home.join(keystate::ENV_FILE).display()
            ),
            None => "there is no home in use, so there is nowhere to write a key".to_string(),
        };
        ui.label(RichText::new(where_line).weak());
        if let Some(note) = self.key_note.clone() {
            ui.label(RichText::new(note).weak());
        }
        if cancel {
            self.key_entry = None;
            self.key_note = None;
            self.key_prompted = true;
            return;
        }
        // Keep the typing between frames, and save only on the click.
        self.key_entry = Some(value);
        if save {
            self.save_key();
        }
    }

    /// Save what is in the field, and say where it went - never what it was.
    fn save_key(&mut self) {
        let Some(value) = self.key_entry.clone() else { return };
        let Some(home) = self.context.plan.home_path().map(std::path::Path::to_path_buf) else {
            self.key_note =
                Some("there is no home in use, so there is nowhere to write a key".to_string());
            return;
        };
        match keystate::write_env_key(&home, &value) {
            Ok(path) => {
                self.key_entry = None;
                self.key_prompted = true;
                self.context.console.push(&format!(
                    "[vncode] the model key was saved to {} (the value is never read back and never written to a log)",
                    path.display()
                ));
                // Re-read the layers, so the row turns green from the SAME reader the log
                // line and the harness use - not from an assumption about what was written.
                self.context.key_state = keystate::read(self.context.plan.home_path());
                self.key_note = Some(format!(
                    "saved to {} - the harness resolves it from there as its DEEPSEEK_API_KEY fallback layer",
                    path.display()
                ));
            }
            // The value stays in the field so it can be fixed, and the sentence never
            // contains it.
            Err(message) => self.key_note = Some(message),
        }
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

    /// What the panel itself has to say, and what the copy had to say.
    ///
    /// The copy's own sentence used to be drawn ONLY inside `Details`, which is how a
    /// press that did nothing at all - "there is nothing to adopt from that home" - read
    /// as a button that does nothing. Both now stand at the top of whichever screen the
    /// reader is on: the first-run choice and the panel.
    fn notices(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(notice) = self.notice.as_ref() {
            lines.push(notice.clone());
        }
        if let Some(note) = self.adopt_note.as_ref() {
            lines.push(note.clone());
        }
        lines
    }

    fn draw_notices(&self, ui: &mut egui::Ui) {
        for line in self.notices() {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("! ").color(WARN));
                ui.label(line);
            });
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
    ///
    /// It follows that Start must never take the other way out either: with no installer
    /// beside this app it REFUSES with a sentence rather than opening a bare interface
    /// and leaving the reader to work out why the pack is missing.
    fn start(&mut self) {
        self.notice = None;
        let action = start_action(
            self.pack_missing(),
            self.context.setup_entries.is_some(),
            self.context.setup.is_running(),
        );
        match action {
            // The install runs first, and the Start that was waiting for it goes ahead
            // when it succeeds (see the finish handler in `logic`).
            StartAction::Install => {
                self.next = Some(Next::Start);
                self.run_setup(SetupKind::Install);
                return;
            }
            StartAction::Wait => {
                self.next = Some(Next::Start);
                self.notice = Some(
                    "the pack is being installed into this home - the harness starts as soon as it finishes".to_string(),
                );
                return;
            }
            StartAction::Refuse => {
                self.notice = Some(
                    "this home has none of this pack's bundles, and there is no installer beside this app (scripts/setup/ is missing), so starting the harness here would open the bare interface without the right bar, the editor or the themes. Run the app from the vncode folder, or install the pack yourself, and press Start again.".to_string(),
                );
                return;
            }
            StartAction::Launch => {}
        }
        self.opened_for = None;
        self.last_stop = None;
        self.surface = None;
        // A hand-off from the previous instance has nothing to say about this one.
        self.hand_off = None;
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
    ///
    /// The work happens on a thread (`browser::SETTLE` is up to 1.5 s, and a walk can take
    /// several) and the answer is picked up in `logic`. **A hand-off already in flight is
    /// not restarted**: pressing the button twice must not open two tabs, and the settle
    /// window is exactly what a second press would otherwise race.
    ///
    /// Two facts travel with the walk, and both are MEASUREMENTS rather than policy: the
    /// profile directory this app can offer a Chromium (`<app root>/browser`, so a
    /// confinement that refuses the browser its own profile is answered rather than merely
    /// reported), and whether that retry goes FIRST - it does when this app's own probe of
    /// the machine's temp directory was refused, because that is what a session which
    /// confines what this app starts looks like, and a doomed launch is owed to nobody.
    fn start_hand_off(&mut self) {
        if self.hand_off.is_some() {
            return;
        }
        self.notice = None;
        let Some(url) = self.status().navigate_url().map(str::to_string) else {
            self.notice = Some(
                "there is no address to open yet - press Start and wait for the harness to be ready"
                    .to_string(),
            );
            return;
        };
        let chosen = self.context.browser.clone();
        let profile = self
            .context
            .plan
            .app_root()
            .or(self.context.prefs_root.as_deref())
            .map(browser::own_profile_dir);
        let confined = self.context.plan.temp.is_some();
        let slot = Arc::new(Mutex::new(None));
        let landing = Arc::clone(&slot);
        self.hand_off = Some(slot);
        std::thread::spawn(move || {
            let report =
                browser::hand_off(&chosen, &url, profile.as_deref(), confined, browser::SETTLE);
            if let Ok(mut landing) = landing.lock() {
                *landing = Some(report);
            }
        });
    }

    /// What the hand-off did, in the log and on the `browser` row.
    ///
    /// **Every rung's own sentence goes into the transcript**, because "I pressed the
    /// button and nothing happened" is a bug report this panel used to be unable to
    /// answer: the launch's result lived only in a row that said "opened in Google
    /// Chrome (a new tab)" - which is what it said while Chrome was dying on the way up,
    /// and what it said while the platform's opener exited zero over a window that never
    /// appeared. The console redacts on the way in, so the address can be named in full.
    fn finish_hand_off(&mut self, report: browser::HandOff) {
        for line in &report.lines {
            self.context.console.push(&format!("[vncode] {line}"));
        }
        match report.took {
            Some(label) => {
                // A page in a browser of the person's own, or a window of this app's own
                // making: the row says which, because they are different windows.
                self.surface = Some(if report.own_profile {
                    format!("{label} (a window of its own, with a profile in this folder)")
                } else {
                    format!("{label} (a new tab)")
                });
                let address = self
                    .status()
                    .public_url()
                    .unwrap_or_else(|| "the harness".to_string());
                self.context.console.push(&format!("[vncode] opened {address} in {label}"));
            }
            None => {
                self.surface = None;
                self.context.console.push(&format!("[vncode] {}", report.refusal()));
                self.notice = Some(format!("{}.{}", report.refusal(), self.confined_hint()));
            }
        }
    }

    /// The sentence that explains a browser that could not start, when this app has the
    /// measurement that names the reason.
    ///
    /// A browser needs its own profile directory, and a process this app starts inherits
    /// whatever confinement this app runs under. The app already MEASURES that: when the
    /// machine's temp directory refuses the probe, a child of this process is confined
    /// (`env::choose_temp`), and a confined Chrome dies at startup -
    /// `Crashpad … settings.dat: Access is denied`, measured. The walk answers that with a
    /// profile inside this folder, so this sentence is what is left when even that did not
    /// work, and it names the step that exists rather than leaving a grey button.
    fn confined_hint(&self) -> String {
        if self.context.plan.temp.is_none() {
            return String::new();
        }
        // MEASURED, and what used to end here was WRONG. The old sentence said "Start vncode
        // by double-clicking scripts\run-desktop.bat, outside that session, and the tab
        // opens." The run that disproved it was launched from Explorer - outside every
        // session - and a launched Chrome still exited `0x80000003` there, while the OS web
        // engine drew the same page inside this window. Both facts came from ONE process (P0),
        // so this no longer promises that starting somewhere else helps.
        if pane_available() {
            " A browser this app starts is refused on this machine (measured: Chrome exits 0x80000003 here AND when the app is launched from Explorer, so starting it somewhere else is not the answer). Use the `harness` tab above: it draws the harness in this window and starts no browser.".to_string()
        } else {
            " A browser this app starts is refused on this machine (measured: Chrome exits 0x80000003 here AND when the app is launched from Explorer, so starting it somewhere else is not the answer). This build has no pane - it is an opt-in feature - so there is no surface left on this machine that can show the page.".to_string()
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
        // A WINDOW THAT CLOSES MID-INSTALL TAKES THE INSTALLER WITH IT. Measured on a
        // real machine: the npm log stopped in the middle of resolving the harness's
        // dependency graph, the profile was left listing the bare harness, and the next
        // attempt re-added all twenty-four bundles from scratch because the entry point
        // implies `-Force`. So the first close request while work is in flight is
        // refused with a sentence; the second is honoured, because a window nobody can
        // close is worse.
        let busy_now = self.context.setup.is_running() || self.context.adopt.is_running();
        if !busy_now {
            self.close_refused = false;
        }
        if busy_now && !self.close_refused && ctx.input(|input| input.viewport().close_requested())
        {
            self.close_refused = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            self.notice = Some(
                "an install or a copy is in flight: the window stayed open so it can finish (closing again stops it, and the profile is left as it stands)".to_string(),
            );
        }
        // A step that was asked for while another was running. The "was" is read BEFORE
        // the refresh, because the refresh is what consumes the transition.
        let setup_was = self.context.setup.is_running();
        let adopt_was = self.context.adopt.is_running();
        self.refresh_pack_state();
        // The install's clock. A step that starts timestamps itself, and every new line
        // the installer prints moves the second mark, so the row can say "nothing for
        // 40s" about the phase that really is silent instead of about the whole run.
        let setup_now = self.context.setup.status();
        if setup_now.running {
            if self.setup_started.is_none() {
                self.setup_started = Some(std::time::Instant::now());
                self.installer_last = None;
                self.installer_last_at = std::time::Instant::now();
            }
            if setup_now.last != self.installer_last {
                self.installer_last = setup_now.last.clone();
                self.installer_last_at = std::time::Instant::now();
            }
        } else {
            self.setup_started = None;
        }

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
        // ASK ONCE, WHEN THERE IS NO KEY AT ALL - and ask in THIS window.
        //
        // A fresh portable home starts keyless by construction: nothing is copied from the
        // machine, and `$DSH_HOME/.env` does not exist yet. Measured: the panel said
        // "DeepSeek key: not found" beside a home that had 24 bundles and no way to do
        // anything about it in the screen the person was looking at. So the field opens
        // itself once per run, the person pastes, and the key lands in the folder.
        if !self.context.key_state.loaded() && !self.key_prompted && !self.needs_setup() {
            self.key_prompted = true;
            self.key_entry = Some(String::new());
            self.key_note = Some(
                "this home has no model key yet: paste it here and press Save - it is written into this folder as DEEPSEEK_API_KEY, never read back and never logged (or add it in the harness's Settings > Models once it is running)"
                    .to_string(),
            );
        }
        // A copy just finished: the home it copied INTO is the one in use, so the
        // location map and the key state are re-read rather than assumed - and the
        // second half of the card's own promise is kept. "The pack is installed into
        // the copy next" was a sentence nothing acted on: the copy landed, the pack row
        // went on saying "not installed here yet", and the person had to work out that
        // a second press was owed. The installer must not run under a live harness and
        // nothing is running at this moment, so it starts here.
        if adopt_was && !self.context.adopt.is_running() {
            self.replan();
            let copied = self.context.adopt.state().failed.is_none();
            if copied {
                let live = self.status().phase.is_live();
                match chain_after_copy(
                    self.pack_missing(),
                    self.context.setup_entries.is_some(),
                    self.context.setup.is_running(),
                    live,
                ) {
                    Some(kind) => self.run_setup(kind),
                    None if live && self.pack_missing() => {
                        self.notice = Some(
                            "the copy is in the home now in use; the pack is installed into it by Stop and install on the pack row, because the installer must not re-link a profile a running harness has read".to_string(),
                        );
                    }
                    None => {}
                }
            }
        }

        // The browser tab is opened once the ready line names a loopback URL - the
        // same hand-off `scripts/run-web` makes, with the URL as ONE argv element,
        // through a program this app found rather than through a shell. One tab per
        // INSTANCE (keyed on the pid), not one per frame.
        //
        // A hand-off already in flight is picked up here rather than waited on: the
        // rungs are watched for up to `browser::SETTLE`, and a window that stopped
        // drawing for that long would read as a hang.
        if let Some(report) = self
            .hand_off
            .as_ref()
            .and_then(|slot| slot.lock().ok().and_then(|slot| slot.clone()))
        {
            self.hand_off = None;
            self.finish_hand_off(report);
        }
        let status = self.status();
        if status.phase == Phase::Running && self.opened_for != status.pid {
            self.opened_for = status.pid;
            // With an engine compiled in, the harness is shown in THIS window and the
            // automatic hand-off is not started at all: `Open in my browser` on the pane's
            // own bar is the way to a browser, and it is a click rather than a surprise.
            #[cfg(not(feature = "pane"))]
            self.start_hand_off();
        }

        // Poll: the supervisor's state changes on its own thread.
        ctx.request_repaint_after(POLL);
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        // The frame carries the window handle the pane is created against, so a build WITHOUT
        // the pane has nothing to do with it. It is named here rather than prefixed with an
        // underscore on purpose: the pane build DOES use it, and one name for one parameter is
        // what keeps both builds the same function instead of two that drift.
        #[cfg(not(feature = "pane"))]
        let _ = frame;

        // THE CHOICE COMES FIRST, and while it is unmade it IS the window: no header,
        // no log, no rows - one question and the cards that answer it.
        if self.needs_setup() {
            self.setup_screen(ui);
            return;
        }
        let status = self.status();
        self.header(ui, &status);

        // **The harness page, when this build has an engine.**
        //
        // It owns everything below the header, and that is the whole reason it can be a
        // child view at all: a child web view paints ABOVE the surface this panel draws on
        // and cannot be clipped, so nothing of ours may go inside its rectangle. The page
        // is drawn INSTEAD of the rows, never over them.
        //
        // It is asked for nothing and hands nothing back: with the pane this app starts no
        // browser, so there is no token to hand to another program, and Stop is one control
        // in the header this page sits under.
        #[cfg(feature = "pane")]
        {
            let data_dir = self.context.plan.app_root().map(|root| root.join("webview"));
            self.pane.show(ui, frame, &status, data_dir, false);
            if self.pane.owns_the_area() {
                return;
            }
        }

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
                // back in after a tab is closed by accident. It stays live while a
                // hand-off is in flight - the button is the control the reader pressed,
                // and the row below says what the press is doing.
                //
                // **Present only in a build WITHOUT the pane.** With the pane this app opens
                // no browser, so a button that opened one would be a control that contradicts
                // the surface: the harness is already in this window, one tab away.
                #[cfg(not(feature = "pane"))]
                {
                    let running = status.phase == Phase::Running;
                    let label = if self.hand_off.is_some() { "Opening…" } else { "Open tab" };
                    let open = ui
                        .add_enabled(running || self.hand_off.is_some(), egui::Button::new(label))
                        .on_hover_text(
                            "opens the harness in the chosen browser, with the launch token the panel never draws",
                        );
                    if open.clicked() {
                        self.start_hand_off();
                    }
                    if !running {
                        open.on_disabled_hover_text(
                            "the harness is not running - press Start, and Open tab lights up",
                        );
                    }
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
    /// working Install button can look like a broken one. It is also given `-Resume`,
    /// which is the difference between a second attempt that costs seconds and one
    /// that re-adds every bundle the profile already lists (see [`setup_extras`]).
    fn run_setup(&mut self, kind: SetupKind) {
        self.notice = None;
        let Some(entries) = self.context.setup_entries.clone() else {
            self.notice = Some(
                "there is no installer beside this app - scripts/setup/ is missing, so this build can only supervise a pack that is already installed".to_string(),
            );
            return;
        };
        let entry = entries.for_kind(kind).to_path_buf();
        let extra = setup_extras(kind);
        let (environment, home_arguments) = self.installer_plan();
        if let Err(message) =
            self.context.setup.start(kind, &entry, &extra, &environment, &home_arguments)
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
            if !self.notices().is_empty() {
                self.draw_notices(ui);
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
                let setup = self.context.setup.status();
                if setup.running {
                    // WHAT IS IT DOING, HOW FAR ALONG, AND HOW LONG IT HAS BEEN QUIET.
                    // The installer's own lines are in the log below, but "installing…"
                    // with nothing moving is what an install looked like while npm
                    // resolved the harness's whole dependency graph in silence: minutes of
                    // nothing, and the word for it was "it doesn't work". The last line,
                    // the elapsed time and the quiet time are three facts that cannot be
                    // mistaken for a hang - and the quiet one names the phase, because
                    // npm's resolution really does print nothing.
                    ui.spinner();
                    let elapsed = self
                        .setup_started
                        .map(|started| started.elapsed())
                        .unwrap_or_default();
                    let quiet = self.installer_last_at.elapsed();
                    let mut line = format!(
                        "{}ing · {}",
                        setup.kind.map(SetupKind::label).unwrap_or("work"),
                        match setup.last.as_deref() {
                            Some(last) => last.to_string(),
                            None => "starting the installer".to_string(),
                        }
                    );
                    line.push_str(&format!(" · {}", short_duration(elapsed)));
                    if quiet.as_secs() >= QUIET_AFTER_SECS {
                        line.push_str(&format!(
                            " · no new output for {} - npm is resolving the harness's dependency graph, which prints nothing (normal, seconds when the cache is warm)",
                            short_duration(quiet)
                        ));
                    }
                    ui.label(RichText::new(line).color(WARN));
                } else {
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
                }
                if !setup.running && self.pack_missing() && self.context.setup_entries.is_some() {
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
                        .on_hover_text(
                            "runs scripts/setup/install.* with this home's -DshHome, resuming what is already installed",
                        )
                        .clicked()
                    {
                        self.run_setup(SetupKind::Install);
                    }
                    ui.label(RichText::new("· Start installs it for you too").weak());
                } else if !setup.running && self.context.setup_entries.is_none() {
                    ui.label(RichText::new("no installer beside this app").weak());
                }
                if let Some(code) = setup.exit.filter(|code| *code != 0) {
                    ui.label(
                        RichText::new(format!("· the last install FAILED (exit {code}) - the log has the installer's own output"))
                            .color(WARN),
                    );
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
                        // NO "REPLACE" HERE, deliberately. The managed
                        // `$DSH_HOME/.credentials.yaml` sits ABOVE the `.env` fallback in
                        // the harness's own resolution, so a key typed into this window
                        // would be ignored while a stored one exists - and a button that
                        // looks like it changes something and does not is worse than no
                        // button. Changing a stored key is the harness's own Models page.
                        ui.label(
                            RichText::new("· change it in the harness's Settings > Models")
                                .weak(),
                        );
                    }
                    None => {
                        ui.label(RichText::new("not found").color(WARN));
                        // THE FIELD IS IN THIS WINDOW, because a fresh portable home starts
                        // with no key and the person is looking at THIS screen. What it
                        // writes is `<home>/.env` - a layer the harness's own credential
                        // resolution reads (`@deepseek-ai/dsh-credentials-local` falls back
                        // to the invoking project's and the home's `.env`) - and never the
                        // managed `.credentials.yaml`, which this app has no business
                        // rewriting.
                        if ui
                            .button("Add key")
                            .on_hover_text(format!(
                                "type it here: it is written to {} as DEEPSEEK_API_KEY, never read back and never logged",
                                keystate::ENV_FILE
                            ))
                            .clicked()
                        {
                            self.key_entry = Some(String::new());
                            self.key_note = None;
                        }
                        ui.label(
                            RichText::new("· or add one in the harness's Settings > Models")
                                .weak(),
                        );
                    }
                };
            });
            ui.end_row();
            if self.key_entry.is_some() || self.key_note.is_some() {
                ui.label("");
                ui.vertical(|ui| self.key_field(ui));
                ui.end_row();
            }

            // --- browser ------------------------------------------------------------
            // **Absent from a build WITH the pane.** That build never starts a browser, so a
            // chooser and a "which browser took it" line would be a row about nothing - and a
            // control whose answer nothing reads is worse than no control.
            #[cfg(not(feature = "pane"))]
            {
                ui.label(RichText::new("browser").strong());
                ui.horizontal_wrapped(|ui| {
                    let current = self.context.browser.id;
                    let mut chosen = current;
                    egui::ComboBox::from_id_salt("browser")
                        .selected_text(self.context.browser.label)
                        .show_ui(ui, |ui| {
                            for browser in &self.context.browsers {
                                if ui.selectable_label(browser.id == current, browser.label).clicked()
                                {
                                    chosen = browser.id;
                                }
                            }
                        });
                    if chosen != current {
                        self.choose_browser(chosen);
                    }
                    match &self.surface {
                        Some(what) => ui.label(RichText::new(format!("· opened in {what}")).weak()),
                        None if self.hand_off.is_some() => {
                            ui.spinner();
                            ui.label(
                                RichText::new(format!(
                                    "· opening in {} - the log says which rung took it",
                                    self.context.browser.label
                                ))
                                .weak(),
                            )
                        }
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
            }
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
                Some(root) => {
                    let tree = self.context.root.clone();
                    let portable = tree
                        .as_deref()
                        .map(|tree| appdata::portable_root(tree).is_some())
                        .unwrap_or(false);
                    ui.horizontal_wrapped(|ui| {
                        ui.label(
                            RichText::new(format!(
                                "{}  ({})",
                                root.display(),
                                self.context.plan.home.app_root_origin_label()
                            ))
                            .monospace(),
                        );
                        // KEEP EVERYTHING IN THIS FOLDER. One click leaves the marker the
                        // root ladder reads, so the NEXT start puts the home, the
                        // preferences, the window record and the npm cache inside this
                        // folder - a portable installation, which is what a folder copied
                        // to another machine needs. The running app cannot move its own
                        // root, so the button says "restart" rather than pretending.
                        if portable {
                            ui.label(
                                RichText::new("· this folder, and kept next time").color(OK),
                            );
                        } else if let Some(tree) = tree {
                            let busy = self.context.setup.is_running()
                                || self.context.adopt.is_running();
                            if ui
                                .add_enabled(!busy, egui::Button::new("Keep everything in this folder"))
                                .on_hover_text(format!(
                                    "writes {} and restarts the app into it - the home, the preferences and the caches then live inside this folder",
                                    appdata::portable_marker(&tree).display()
                                ))
                                .clicked()
                            {
                                match appdata::mark_portable(&tree) {
                                    Ok(root) => {
                                        self.notice = Some(format!(
                                            "this folder is now a portable installation: {} is the root from the next start on - close the app and open it again",
                                            root.display()
                                        ));
                                    }
                                    Err(error) => self.notice = Some(error),
                                }
                            }
                        }
                    });
                }
                None => {
                    ui.label(RichText::new("none could be written").color(WARN));
                }
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

/// How long an install may print nothing before the pack row says so out loud.
///
/// Measured: the silent phase is npm resolving the harness (`npm exec`), about 50-60 s on
/// a cold cache and seconds when it is warm. Twenty seconds is long enough that the row
/// does not narrate ordinary gaps, short enough that nobody concludes it has hung.
const QUIET_AFTER_SECS: u64 = 20;

/// A duration a person reads at a glance: `4s`, `1m 05s`, `12m`.
fn short_duration(elapsed: std::time::Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let rest = seconds % 60;
    if minutes < 60 {
        return format!("{minutes}m {rest:02}s");
    }
    format!("{}h {:02}m", minutes / 60, minutes % 60)
}

/// What **Start** must do, from three facts the panel already has.
///
/// It is a decision rather than four lines inside the button handler because each arm
/// is a different promise, and one of them was wrong: with the pack missing and no
/// installer beside the app, the old `if` fell through and started the harness anyway -
/// the bare interface, which is exactly the state this app's own comments call "reads as
/// a broken app".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartAction {
    /// The home has the pack: start the harness.
    Launch,
    /// No pack, and an installer is here: install first, then start.
    Install,
    /// An install is already in flight: wait - it starts the harness when it succeeds.
    Wait,
    /// No pack and nothing to install it with: refuse, with a sentence.
    Refuse,
}

fn start_action(pack_missing: bool, has_installer: bool, installing: bool) -> StartAction {
    if !pack_missing {
        return StartAction::Launch;
    }
    if !has_installer {
        return StartAction::Refuse;
    }
    if installing {
        return StartAction::Wait;
    }
    StartAction::Install
}

/// The step a finished **copy** owes the person: install the pack into the home it just
/// filled, when there is one to install, none already running, and no harness LIVE.
///
/// The live case is the installer's own rule rather than a caution: re-linking a profile
/// under a process that has already read it is what the disabled Install button prevents,
/// and a copy can be started from the first-run screen while an instance started on
/// another home is still up. `None` there - the pack row's own `Stop and install` is the
/// way, and the panel says so.
///
/// `None` in every other case too, including a home that already has the pack: the copy
/// is then the whole job.
fn chain_after_copy(
    pack_missing: bool,
    has_installer: bool,
    installing: bool,
    harness_live: bool,
) -> Option<SetupKind> {
    (pack_missing && has_installer && !installing && !harness_live).then_some(SetupKind::Install)
}

/// The flags the panel hands the installer, and the reason each one is there.
///
/// `-Resume` is the whole difference between a second attempt that costs seconds and
/// one that costs a quarter of an hour. The entry point IMPLIES `-Force` so that a
/// double-click always installs the latest edits, which is right for a person and wrong
/// for this panel: it re-adds all twenty-four bundles even when twenty-three are already
/// in the profile at the same version - measured on a real machine, where an install
/// interrupted by closing the window left the profile listing the bare harness, and the
/// next press re-resolved the whole dependency graph for every bundle again. `-Resume`
/// asks for the installer's own default: add what is missing, skip what is current.
///
/// Nothing is passed for an uninstall: it has no implied flag to undo.
fn setup_extras(kind: SetupKind) -> Vec<String> {
    match kind {
        SetupKind::Install => vec!["-Resume".to_string()],
        SetupKind::Uninstall => Vec::new(),
    }
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
    fn start_installs_refuses_or_waits_rather_than_opening_a_bare_harness() {
        // The pack is there: the ordinary Start.
        assert_eq!(start_action(false, true, false), StartAction::Launch);
        assert_eq!(start_action(false, false, false), StartAction::Launch);
        // No pack, and an installer beside the app: install first.
        assert_eq!(start_action(true, true, false), StartAction::Install);
        // No pack, an installer, and a run already in flight: wait for it.
        assert_eq!(start_action(true, true, true), StartAction::Wait);
        // NO PACK AND NOTHING TO INSTALL IT WITH: refuse. This is the arm that used to
        // fall through and start the bare interface.
        assert_eq!(start_action(true, false, false), StartAction::Refuse);
        assert_eq!(start_action(true, false, true), StartAction::Refuse);
    }

    #[test]
    fn a_finished_copy_owes_an_install_exactly_when_one_is_missing_and_possible() {
        assert_eq!(chain_after_copy(true, true, false, false), Some(SetupKind::Install));
        // The home already has the pack: the copy was the whole job.
        assert_eq!(chain_after_copy(false, true, false, false), None);
        // No installer beside this app: the panel says so instead of pretending.
        assert_eq!(chain_after_copy(true, false, false, false), None);
        // One installer at a time.
        assert_eq!(chain_after_copy(true, true, true, false), None);
        // A LIVE harness: the installer must not re-link the profile it has read - the
        // pack row's own "Stop and install" is the way, and the panel says so.
        assert_eq!(chain_after_copy(true, true, false, true), None);
    }

    #[test]
    fn the_panel_asks_the_installer_to_resume_and_never_to_force_all_of_it() {
        // The entry point implies `-Force` for a double-click; the panel must undo that
        // or a second attempt re-adds every bundle the profile already lists.
        assert_eq!(setup_extras(SetupKind::Install), vec!["-Resume".to_string()]);
        // An uninstall has no implied flag to undo, so the panel passes nothing.
        assert!(setup_extras(SetupKind::Uninstall).is_empty());
    }

    #[test]
    fn a_duration_is_written_the_way_a_person_reads_a_clock() {
        use std::time::Duration;
        assert_eq!(short_duration(Duration::from_secs(4)), "4s");
        assert_eq!(short_duration(Duration::from_secs(59)), "59s");
        // The measured silent phase: npm resolving the harness, about a minute.
        assert_eq!(short_duration(Duration::from_secs(65)), "1m 05s");
        assert_eq!(short_duration(Duration::from_secs(600)), "10m 00s");
        assert_eq!(short_duration(Duration::from_secs(3_725)), "1h 02m");
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
