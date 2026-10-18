//! `vncode`: the front door, and nothing else.
//!
//! This binary draws no window and no web view. It decides four things - the root, the
//! home, the key and the pack - and then it runs the script a person would run:
//! `scripts/run-web.bat` on Windows, `scripts/run-web.sh` everywhere else, in the
//! foreground, with the composed environment and `-DshHome` so both halves agree about
//! which home is in use.
//!
//! ```text
//! vncode              install if needed -> ask for the key if there is none -> run-web
//! vncode install      scripts/setup/install.* against the home in use
//! vncode uninstall    scripts/setup/uninstall.* against it
//! vncode status       the facts, and nothing started
//! vncode key          ask for the DeepSeek key, write it into <home>/.env
//! vncode -Help        the verbs and flags, without starting anything
//! ```
//!
//! Two rules survive from the shell this replaces, because both are the record of a bug
//! measured on a real machine:
//!
//! 1. **A key is never printed.** The panel-era rule was "a layer NAME, never a value";
//!    the value now never leaves the prompt, is written to one file, and is not read back.
//! 2. **Every child's environment is composed, not inherited** (`vn_shell_runtime::env`),
//!    because a variable that is merely unset is still inherited from whoever started this.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use vn_shell_core::keystate::{self, KeyState};
use vn_shell_core::options::{self, Command, Options};
use vn_shell_core::{launch, ports, profile};
use vn_shell_runtime as runtime;
use vn_shell_runtime::setup::{self, SetupKind};
use vn_shell_runtime::Plan;

/// The profile the launcher starts, and the one the pack is installed into. `dsh web` and
/// `dsh --profile web` are the same profile: this is the alias, not a second one.
const PROFILE: &str = launch::PROFILE;

fn main() {
    let options = match options::parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("[vncode] {message}");
            std::process::exit(1);
        }
    };
    if options.help {
        options::print_usage();
        return;
    }
    if options.version {
        options::print_version();
        return;
    }
    let code = match run(&options) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("[vncode] {message}");
            1
        }
    };
    std::process::exit(code);
}

/// Resolve, report, then do the one thing that was asked for.
fn run(options: &Options) -> Result<i32, String> {
    let plan = runtime::plan(options, None)?;
    announce(&plan);
    let environment = runtime::env::for_plan(&plan);
    let home_arguments = runtime::env::dsh_home_arguments(&plan.home);

    match options.command() {
        Command::Status => {
            status(&plan);
            Ok(0)
        }
        Command::Key => {
            // A key is not required for the command to have done its job: a person who
            // changes their mind gets a sentence and exit 0, not a failure.
            ask_and_save_key(&plan)?;
            Ok(0)
        }
        Command::Install => setup_run(SetupKind::Install, &plan, &environment, &home_arguments),
        Command::Uninstall => setup_run(SetupKind::Uninstall, &plan, &environment, &home_arguments),
        Command::Start => start(options, &plan, &environment, &home_arguments),
    }
}

/// The facts, once, in the same words `run-web` uses.
fn announce(plan: &Plan) {
    println!("[vncode] pinned dsh version: {}", plan.version);
    match plan.app_root() {
        Some(root) => println!(
            "[vncode] VNCODE_HOME: {} ({})",
            root.display(),
            plan.app_root_origin_label()
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
    println!("[vncode] child environment: {}", plan.env_summary());
    for note in &plan.notes {
        println!("[vncode] note: {note}");
    }
}

/// The extra facts `status` adds: what is installed, and where the launcher is.
fn status(plan: &Plan) {
    match plan.home_path() {
        Some(home) => match profile::bundles(home, PROFILE) {
            Some(bundles) => println!(
                "[vncode] pack: {} ({} bundle(s) in the {PROFILE} profile)",
                if profile::has_pack(&bundles) { "installed" } else { "NOT installed" },
                bundles.len()
            ),
            None => println!("[vncode] pack: no {PROFILE} profile in this home yet"),
        },
        None => println!("[vncode] pack: no home was decided, so nothing can be installed"),
    }
    match launcher(plan) {
        Ok(entry) => println!("[vncode] launcher: {}", entry.display()),
        Err(message) => println!("[vncode] launcher: {message}"),
    }
    match plan.port_hint {
        Some(port) => {
            println!("[vncode] port: {port} (free now; start chooses again, -Port overrides)")
        }
        None => println!("[vncode] port: none free right now"),
    }
    match plan.root.as_deref() {
        Some(root) => println!("[vncode] root: {}", root.display()),
        None => println!("[vncode] root: none found above this binary"),
    }
    for (program, why) in [("node", "the harness needs it"), ("npx", "the launcher runs it")] {
        match which(program) {
            Some(path) => println!("[vncode] {program}: {}", path.display()),
            None => println!("[vncode] {program}: NOT on PATH ({why})"),
        }
    }
}

/// The whole path: the pack, then the key, then the launcher.
fn start(
    options: &Options,
    plan: &Plan,
    environment: &runtime::ChildEnv,
    home_arguments: &[std::ffi::OsString],
) -> Result<i32, String> {
    // 1. THE PACK. Installed before anything runs, because the installer re-links the
    // profile and must not run under a live harness - and nothing is running yet.
    if !pack_is_installed(plan) {
        println!("[vncode] this home does not list the pack's bundles - installing them first");
        let code = setup_run(SetupKind::Install, plan, environment, home_arguments)?;
        if code != 0 {
            return Err(format!(
                "the pack installer failed (exit code {code}), so nothing was started"
            ));
        }
    }

    // 2. THE KEY. Asked for only when there is none, and only at a terminal: an
    // unattended run (a scheduler, a check) must not block on a prompt that nobody sees.
    let key = keystate::read(plan.home_path());
    if key.source().is_none() {
        println!("[vncode] no DeepSeek key was found for this home");
        ask_and_save_key(plan)?;
    }

    // 3. THE LAUNCHER. The same file a person double-clicks, in the foreground: it runs
    // the harness, watches for the URL line, opens the tab and takes Ctrl+C.
    //
    // **THE PORT IS THIS APP'S OWN, NEVER THE SHARED 3080**, and that is a measured rule
    // rather than a preference: 3080 is what every `dsh web` on the machine reaches for,
    // so a run that asks for it either collides (`EADDRINUSE` - measured by the first real
    // run of this binary, on a machine whose harness was already answering there) or, worse,
    // shares it with a process whose launch token this run does not have. A free port costs
    // nothing because this app opens the tab itself with the token in it: nobody types an
    // address and nothing is remembered per origin. `-Port 3080` is how to ask for the
    // shared origin on purpose.
    let port = match options.port {
        0 => ports::free_port().ok_or_else(|| {
            "this machine would not hand out a free loopback port - pass -Port <n>".to_string()
        })?,
        asked => asked,
    };
    let entry = launcher(plan)?;
    let mut command = launcher_command(&entry);
    command.args(home_arguments);
    command.arg("-Port").arg(port.to_string());
    environment.apply(&mut command);
    println!("[vncode] port: {port} (chosen by this app, never the shared 3080)");
    println!("[vncode] running {}", entry.display());
    println!("[vncode] keep this window open - the harness runs in it. Ctrl+C stops it.");
    println!();
    let status = command
        .status()
        .map_err(|error| format!("could not run {}: {error}", entry.display()))?;
    Ok(status.code().unwrap_or(1))
}

/// Whether the pack's bundles are in the profile the launcher will start.
fn pack_is_installed(plan: &Plan) -> bool {
    plan.home_path()
        .and_then(|home| profile::bundles(home, PROFILE))
        .map(|bundles| profile::has_pack(&bundles))
        .unwrap_or(false)
}

/// Run one of the two setup entry points, with the child's own output going straight to
/// this console - the same thing a person sees when they run it themselves.
fn setup_run(
    kind: SetupKind,
    plan: &Plan,
    environment: &runtime::ChildEnv,
    home_arguments: &[std::ffi::OsString],
) -> Result<i32, String> {
    let root = plan.root.as_deref().ok_or_else(|| {
        "no checkout or distribution root was found above this binary, so there is no \
         scripts/setup to run"
            .to_string()
    })?;
    let entries = setup::locate(root).ok_or_else(|| {
        format!(
            "no installer under {} - a release folder carries scripts/setup beside the binary",
            root.join("scripts").join("setup").display()
        )
    })?;
    let entry = entries.for_kind(kind);
    let mut command = setup::command_for(entry, &[], environment, home_arguments);
    // `command_for` pipes both streams so a panel could draw them. There is no panel:
    // this run's output is the console's, line for line, exactly as if it were typed.
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    println!("[vncode] {}: running {}", kind.label(), entry.display());
    let status = command
        .status()
        .map_err(|error| format!("could not run {}: {error}", entry.display()))?;
    Ok(status.code().unwrap_or(1))
}

/// Ask for the DeepSeek key and write it into this home's `.env`.
///
/// The value goes from the terminal into one file and nowhere else: it is not printed, it
/// is not logged, and it is not read back. The sentence names the FILE.
fn ask_and_save_key(plan: &Plan) -> Result<(), String> {
    let home = plan.home_path().ok_or_else(|| {
        "no harness home was decided, so there is nowhere to write a key".to_string()
    })?;
    if !std::io::stdin().is_terminal() {
        println!(
            "[vncode] stdin is not a terminal, so no key was asked for. Set {} in the \
             environment, or write it into {}",
            keystate::KEY_REF,
            home.join(keystate::ENV_FILE).display()
        );
        return Ok(());
    }
    println!(
        "[vncode] paste your DeepSeek API key. It is written to {} and never printed.",
        home.join(keystate::ENV_FILE).display()
    );
    let value = rpassword::prompt_password(format!("{}: ", keystate::KEY_REF))
        .map_err(|error| format!("could not read the key: {error}"))?;
    let value = value.trim();
    if value.is_empty() {
        println!("[vncode] nothing was entered, so no key was written");
        return Ok(());
    }
    let path = keystate::write_env_key(home, value)?;
    println!("[vncode] wrote {} to {}", keystate::KEY_REF, path.display());
    Ok(())
}

/// The web launcher beside this tree: the ONE thing that starts node, watches the ready
/// line and opens the tab.
fn launcher(plan: &Plan) -> Result<PathBuf, String> {
    let root = plan.root.as_deref().ok_or_else(|| {
        "no .dsh-version.json was found above this binary, so the web launcher beside it \
         cannot be found either - run vncode from its folder, or pass -DshHome and use \
         scripts/run-web.* directly"
            .to_string()
    })?;
    let name = if cfg!(windows) { "run-web.bat" } else { "run-web.sh" };
    let path = root.join("scripts").join(name);
    if !path.is_file() {
        return Err(format!(
            "{} is missing - this app starts the web launcher, and that file is what runs \
             the harness",
            path.display()
        ));
    }
    Ok(path)
}

/// How the launcher is started.
///
/// On Windows a `.bat` needs `cmd`, and two flags are the launcher's own: `-NoTerminal`
/// keeps the console layer from relaunching this run into a Windows Terminal window that
/// this process would not wait for (it would look like an instant, silent exit), and
/// `-NoPause` keeps it from holding a window open that already exists. On POSIX the
/// script takes no such flags.
fn launcher_command(entry: &Path) -> Process {
    if cfg!(windows) {
        let mut command = Process::new("cmd");
        command.arg("/c").arg(entry).arg("-NoTerminal").arg("-NoPause");
        command
    } else {
        let mut command = Process::new("sh");
        command.arg(entry);
        command
    }
}

/// Where a program is, without running it - for `status` only.
fn which(program: &str) -> Option<PathBuf> {
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| extension.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let direct = directory.join(program);
        if direct.is_file() {
            return Some(direct);
        }
        for extension in &extensions {
            let candidate = directory.join(format!("{program}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Kept honest by the type system rather than a comment: `KeyState` is only ever printed
/// through `console_line`, which names a layer and never a value.
#[allow(dead_code)]
fn key_line(state: &KeyState) -> String {
    keystate::console_line(state)
}
