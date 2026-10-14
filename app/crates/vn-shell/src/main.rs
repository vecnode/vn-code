//! vncode: the shell's binary, and nothing else.
//!
//! Wiring only. The flags, the pin, the home, the browser table, the port, the launch
//! decision and the ready line all live in `vn-shell-core` (pure, `cargo test`ed); the
//! process lifetime lives in `vn-shell-runtime`; the panel lives in `vn-shell-egui`.
//! What is here is the order those are called in, and the two modes that never open a
//! window.
//!
//! The lifetime this binary implements:
//!
//! ```text
//! vncode                     the control panel, idle: no child, no port bound
//! vncode -Mode chrome        ...and Start opens the harness in a browser it found
//! vncode -Mode headless      no window: `stop`, `quit`, `install`, `uninstall` on stdin
//! vncode -Help               what it takes, without starting anything
//! ```
//!
//! There is no single-file build any more: it was a distribution the old
//! distributer assembled, and the distribution is now this app beside the pack it
//! installs (the panel's Install button runs `scripts/setup/install.*`).

use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use vn_shell_core::appprefs::AppPrefs;
use vn_shell_core::browser;
use vn_shell_core::options::{parse_args, print_usage, Mode, Options};
use vn_shell_core::prefs::Preferences;
use vn_shell_core::status::Phase;
use vn_shell_core::windowstate::{self, WindowState};
use vn_shell_core::{appdata, home, keystate, launch};
use vn_shell_egui::{Shell, ShellContext};
use vn_shell_paths::{self as paths, Input};
use vn_shell_runtime::{self as runtime, Console, Setup, SetupKind, Supervisor};

/// The profile the shell starts, and the one the panel names. `dsh web` and
/// `dsh --profile web` are the same profile: this is the alias, not a second one.
/// It is defined in `vn-shell-core` so the supervisor, the prefs reader and the
/// panel's "is the pack installed" row cannot disagree about it.
const PROFILE: &str = launch::PROFILE;

/// How often the headless loop looks at the supervisor.
const HEADLESS_TICK: Duration = Duration::from_millis(200);

fn main() {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("[vncode] {message}");
            std::process::exit(1);
        }
    };
    if options.help {
        print_usage();
        return;
    }

    let mode = options.mode();
    let code = match mode {
        Mode::Headless => headless(options),
        _ => window(options, mode),
    };
    std::process::exit(code);
}

/// The one line every run prints, whatever the mode.
fn banner(mode: Mode) {
    println!("[vncode] vncode shell ({mode} mode)");
}

/// The facts, for the WINDOW modes only.
///
/// In headless mode the worker records these same lines in the log and the log IS
/// the console there, so announcing them as well would print every fact twice - a
/// transcript that says everything two times is a transcript somebody stops
/// reading.
fn announce(plan: &runtime::Plan) {
    println!("[vncode] Pinned dsh version: {}", plan.version);
    match plan.app_root() {
        Some(root) => println!(
            "[vncode] VNCODE_HOME: {} ({})",
            root.display(),
            plan.home.app_root_origin_label()
        ),
        None => println!("[vncode] VNCODE_HOME: none could be written"),
    }
    let (path, why) = plan.home.row();
    println!("[vncode] DSH_HOME: {path} ({why})");
    for refusal in &plan.home.refused {
        println!("[vncode] refused: {}", refusal.line());
    }
    println!("{}", keystate::console_line(&keystate::read(plan.home_path())));
    println!("[vncode] runtime: {}", plan.runtime_line());
    println!("[vncode] child environment: {}", plan.env_line());
    match plan.port_hint {
        Some(port) => println!("[vncode] port: {port} (chosen again when Start is pressed)"),
        None => println!("[vncode] port: none free right now"),
    }
    for note in &plan.notes {
        println!("[vncode] note: {note}");
    }
}

/// The window: the control panel, and whatever the reader asks it to start.
fn window(options: Options, mode: Mode) -> i32 {
    // The app's own root is read FIRST, because two things live in it that decide
    // what the harness gets: the remembered home, and the browser the person chose.
    let app_root = appdata::app_root();
    let app_prefs = AppPrefs::load(app_root.as_deref());
    if app_root.is_some() {
        println!("[vncode] app preferences: {}", app_prefs.line());
    }
    let plan = match runtime::plan(&options, app_prefs.home.as_deref()) {
        Ok(plan) => plan,
        Err(message) => {
            eprintln!("[vncode] {message}");
            return 1;
        }
    };
    banner(mode);
    announce(&plan);

    // The geometry record lives in the APP ROOT, not the harness home: it is the
    // app's own furniture, and it must survive a `-DshHome` that points at a folder
    // shared with `scripts\run-web.bat` (`appdata`'s header has the argument, and the
    // npm cache already follows it).
    let state_path = plan.app_root().map(windowstate::state_path);
    let remembered = match state_path.as_deref().map(windowstate::load) {
        // No app root could be written, so there is nowhere honest to read from or
        // write to: this window simply has no memory.
        None => WindowState::first_launch(),
        // The ordinary first launch: nothing to say, and nothing to fix.
        Some(Err(windowstate::Unusable::Absent)) => WindowState::first_launch(),
        Some(Err(reason)) => {
            // One line, never a refusal: a record this build cannot vouch for
            // costs the reader the default geometry and nothing else.
            println!("[vncode] ignoring the remembered window geometry: {reason}.");
            WindowState::first_launch()
        }
        Some(Ok(remembered)) => remembered,
    };

    let profiles = vn_shell_core::prefs::profile_names(plan.home_path());
    let prefs: Preferences = vn_shell_core::prefs::read(plan.home_path(), PROFILE);
    let key_state = keystate::read(plan.home_path());
    let workspace = std::env::current_dir().ok();
    let repo = launch::repo_root();
    let path_rows = paths::rows(&Input {
        home: plan.home_path(),
        home_origin: plan.home.row().1,
        app_root: plan.app_root(),
        repo_root: repo.as_deref(),
        workspace: workspace.as_deref(),
        profile: PROFILE,
        profiles: &profiles,
    });

    println!(
        "[vncode] opening the control panel in {} mode - nothing is started until Start",
        mode
    );
    // ONE console for both writers: the panel's log is a single transcript, so an
    // install's output and the harness's output share a cursor and a redactor.
    let console = Arc::new(Console::new());
    let supervisor = Arc::new(Supervisor::new(Arc::clone(&console)));
    let setup = Arc::new(Setup::new(Arc::clone(&console)));
    let adopt = Arc::new(runtime::Adopt::new(Arc::clone(&console)));
    let setup_entries = runtime::setup::locate(repo.as_deref().unwrap_or(Path::new(".")));
    if setup_entries.is_none() {
        println!(
            "[vncode] no installer found under scripts/setup - this build can supervise a pack that is already installed, but the panel's Install and Uninstall buttons will be off"
        );
    }

    // What the panel offers about a home this app did not create: USE it in place, or
    // ADOPT a copy of it. The source is the harness's own default (`~/.dsh`), and it
    // is only an offer - the app never walks to it on its own (see `home.rs`).
    let existing_home = home::existing_default_home().filter(|path| {
        home::looks_like_a_harness_home(path) && appdata::harness_home_is_writable(path)
    });
    if let Some(path) = existing_home.as_deref() {
        // Compared in their REAL forms, so `~/.dsh` and a junction to it are one
        // home rather than two.
        let using_it = plan
            .home_path()
            .map(|in_use| {
                vn_shell_core::userpath::canonical(in_use)
                    == vn_shell_core::userpath::canonical(path)
            })
            .unwrap_or(false);
        println!(
            "[vncode] found an existing harness home at {}{}",
            path.display(),
            if using_it { " (in use)" } else { " - the panel offers Use or Adopt" }
        );
    }
    let adopt_offer = vn_shell_core::adopt::offer(existing_home.as_deref(), plan.home_path());
    match &adopt_offer {
        vn_shell_core::adopt::Offer::Available(adoption) => {
            println!("[vncode] adopt is available: {}", adoption.line())
        }
        vn_shell_core::adopt::Offer::Unreadable(path) => println!(
            "[vncode] {} exists but cannot be read, so nothing can be adopted from it",
            path.display()
        ),
        vn_shell_core::adopt::Offer::Nothing => {}
    }

    // The browsers on this machine, Chrome first, with the OS opener last: the table
    // is `browser.rs`, and this is the one place it is read.
    let browsers = browser::detect();
    let chosen = browser::resolve(app_prefs.browser.as_deref(), &browsers);
    println!(
        "[vncode] browsers: {} (using {})",
        browsers
            .iter()
            .map(|browser| browser.label)
            .collect::<Vec<_>>()
            .join(", "),
        chosen.label
    );

    let geometry = Arc::new(Mutex::new(remembered.clone()));
    let app = Shell::new(ShellContext {
        options: options.clone(),
        plan,
        supervisor: Arc::clone(&supervisor),
        console,
        setup: Arc::clone(&setup),
        adopt_offer,
        adopt: Arc::clone(&adopt),
        setup_entries,
        root: repo.clone(),
        paths: path_rows,
        profiles,
        prefs,
        key_state,
        geometry: Arc::clone(&geometry),
        browsers,
        browser: chosen,
        app_prefs,
        prefs_root: app_root,
        existing_home,
    });

    let native = eframe::NativeOptions {
        viewport: vn_shell_egui::viewport(&remembered, "vncode"),
        ..Default::default()
    };
    let result = eframe::run_native(
        "vncode",
        native,
        Box::new(|_context| Ok(Box::new(app) as Box<dyn eframe::App>)),
    );

    // On the way out: the geometry, synchronously, because a value handed to a
    // debounced writer might not reach the disk before the process ends - and
    // then the harness, so closing the window never leaves a `node` holding a port.
    if let Some(path) = state_path.as_deref() {
        if let Ok(state) = geometry.lock() {
            if let Err(error) = windowstate::save(path, &state) {
                eprintln!(
                    "[vncode] could not remember the window geometry in {}: {error}",
                    path.display()
                );
            }
        }
    }
    let outcome = supervisor.stop();
    println!("{}", outcome.line());

    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("[vncode] could not open the control panel: {error}");
            1
        }
    }
}

/// The mode with no window: supervise, print what changes, and take `stop`,
/// `quit`, `install` or `uninstall` on stdin.
///
/// This is not filler. It is the mode that proves the supervisor is separable from
/// the window (M1's exit criterion), it is what a server or a container wants, and
/// it is what `scripts/checks/check-shell.mjs` drives: the check starts this
/// process against a stub CLI, reads the ready line, asks it to stop, and asserts
/// the port came free - with nothing on screen and no display needed. The two
/// setup commands exist for the same reason as the panel's buttons: they run the
/// real installer, so a check can drive the plumbing (`install -Help` installs
/// nothing and proves every step of it).
fn headless(options: Options) -> i32 {
    banner(Mode::Headless);
    println!("[vncode] commands on stdin: stop, quit, install [args], uninstall [args]");

    let console = Arc::new(Console::new());
    let supervisor = Arc::new(Supervisor::new(Arc::clone(&console)));
    let setup = Arc::new(Setup::new(Arc::clone(&console)));
    let root = launch::repo_root();
    let entries = runtime::setup::locate(root.as_deref().unwrap_or(Path::new(".")));
    // The plan is resolved HERE as well as inside `start`, because `install` and
    // `uninstall` have to hand the installer the same composed environment and the
    // same `-DshHome` the harness is given - and that is the plan's answer, not a
    // second reading of the environment. A bad pin or an unusable home is still
    // reported synchronously, which is why this mode resolves it rather than
    // guessing. The remembered home comes from the app's own root, exactly as it does
    // for the window, so a headless run and a panel run choose the same home.
    let app_prefs = AppPrefs::load(appdata::app_root().as_deref());
    let plan = match runtime::plan(&options, app_prefs.home.as_deref()) {
        Ok(plan) => plan,
        Err(message) => {
            eprintln!("[vncode] {message}");
            return 1;
        }
    };
    if let Err(message) = supervisor.start(options, app_prefs.home.clone()) {
        eprintln!("[vncode] {message}");
        return 1;
    }

    // stdin on its own thread, so the loop below can keep reporting the status
    // while it waits - a supervisor that went quiet until a key was pressed would
    // be useless to a person watching it.
    let (commands, inbox) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if commands.send(line).is_err() {
                return;
            }
        }
    });

    // The log IS the console here. Every line the worker records is printed once,
    // through a cursor rather than a tail, so a line cannot be repeated or skipped
    // - and it is the same transcript the panel draws, redaction included.
    let mut cursor = supervisor.log_position();
    loop {
        for line in supervisor.log_since(cursor) {
            println!("{line}");
        }
        cursor = supervisor.log_position();

        let status = supervisor.status();
        if !supervisor.is_live() {
            // The harness ended on its own; there is nothing left to supervise.
            if status.phase == Phase::Stopped {
                println!("{}", status.safe_line());
            }
            return if status.phase == Phase::Failed { 1 } else { 0 };
        }
        match inbox.recv_timeout(HEADLESS_TICK) {
            Ok(command) => {
                // A BYTE ORDER MARK is not a command. PowerShell writes one when it
                // pipes a string into a native process (`"stop" | vncode …`), so
                // without this strip every command from a PowerShell pipeline is
                // "unknown command '<BOM>stop'" - measured, on the first attempt to
                // drive an install from a shell.
                let command = command.trim().trim_start_matches('\u{feff}').trim().to_string();
                let (verb, rest) = match command.split_once(char::is_whitespace) {
                    Some((verb, rest)) => (verb.to_ascii_lowercase(), rest.trim().to_string()),
                    None => (command.to_ascii_lowercase(), String::new()),
                };
                match verb.as_str() {
                    "stop" | "quit" | "exit" => {
                        println!("{}", supervisor.stop().line());
                        return 0;
                    }
                    "install" | "uninstall" => {
                        let kind = if verb == "install" {
                            SetupKind::Install
                        } else {
                            SetupKind::Uninstall
                        };
                        let Some(entries) = entries.as_ref() else {
                            println!(
                                "[vncode] no installer under scripts/setup - nothing to run"
                            );
                            continue;
                        };
                        let extra: Vec<String> = runtime::setup::split_args(&rest);
                        let entry = entries.for_kind(kind).to_path_buf();
                        let environment = runtime::env::for_plan(&plan);
                        let home_arguments = runtime::env::dsh_home_arguments(&plan.home);
                        if let Err(message) = setup
                            .start(kind, &entry, &extra, &environment, &home_arguments)
                        {
                            println!("[vncode] {message}");
                            continue;
                        }
                        // Blocking HERE is right for this mode: it has one job at a
                        // time, and the next line the caller wants is the answer.
                        setup.join();
                    }
                    "" => {}
                    other => println!(
                        "[vncode] unknown command '{other}' - commands: stop, quit, install, uninstall"
                    ),
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // stdin is gone. That is NOT a reason to stop: a headless shell with no
            // stdin is an ordinary way to run this (`vncode -Mode headless < /dev/null`
            // serves until the harness ends), so it simply has no commands.
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    }
}
