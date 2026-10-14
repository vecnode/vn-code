//! Running the pack's own installer from the panel.
//!
//! The panel's Install and Uninstall buttons do not reimplement installing. They
//! run the SAME entry points a person would click - `scripts/setup/install.bat`
//! on Windows, `scripts/setup/install.sh` elsewhere - through the same console
//! layer, with the same flags, and stream what they print into the panel's log.
//! One installer, two ways to reach it.
//!
//! ## The inherited-marker trap, which is why this file is not three lines
//!
//! `scripts/console/adapt.cmd` decides the console a run gets, and it marks the
//! run it has set up with `VNCODE_CONSOLE=1`. An entry point that sees that marker
//! does not set `VNCODE_ARGV` from `%*` (the child of a Windows Terminal relaunch
//! already has the arguments) and `adapt.cmd` returns immediately - so ANY
//! arguments a caller passed are dropped on the floor.
//!
//! That is fine for the paths it was designed for, and it is a trap for this one:
//! the panel is a process that `scripts/run-desktop.bat` started, so it INHERITS
//! the marker, and an Install button that did not clear it would run the installer
//! with no flags at all - measured on this machine, not imagined: the first
//! version of this button ran `install.bat -NoTerminal -NoPause -Help` and watched
//! it start a full install. Every console variable is therefore removed from the
//! child's environment, which puts the entry point back on its first-entry path
//! where `%*` is the truth.
//!
//! ## Why the entry point and not the worker
//!
//! `install.bat` is the file a person double-clicks, and it is the file that
//! knows how to pick a PowerShell (7 first, 5.1 second), how to translate the
//! help spellings PowerShell cannot bind, and how to add the implied `-Force`. The
//! panel calls that, not `install-all.ps1`, so there is one place where "how this
//! pack is installed" is decided.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::console::Console;
use crate::env::ChildEnv;

/// Which way the pack is being moved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupKind {
    Install,
    Uninstall,
}

impl SetupKind {
    pub fn label(self) -> &'static str {
        match self {
            SetupKind::Install => "install",
            SetupKind::Uninstall => "uninstall",
        }
    }
}

/// Where the entry points are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryPoints {
    pub install: PathBuf,
    pub uninstall: PathBuf,
}

impl EntryPoints {
    pub fn for_kind(&self, kind: SetupKind) -> &Path {
        match kind {
            SetupKind::Install => &self.install,
            SetupKind::Uninstall => &self.uninstall,
        }
    }
}

/// The entry points under a checkout or distribution root, if they are there.
///
/// A `None` is a fact the panel shows ("no installer beside this app") rather than
/// an error: the shell works in a folder that carries only `app/`, and someone who
/// moved the binary away from its tree has not broken anything by doing so.
pub fn locate(root: &Path) -> Option<EntryPoints> {
    let directory = root.join("scripts").join("setup");
    let (install, uninstall) = if cfg!(windows) {
        (directory.join("install.bat"), directory.join("uninstall.bat"))
    } else {
        (directory.join("install.sh"), directory.join("uninstall.sh"))
    };
    if install.is_file() && uninstall.is_file() {
        Some(EntryPoints { install, uninstall })
    } else {
        None
    }
}

/// The variables the console layer uses to carry state between an entry point and
/// its relaunched self. Re-exported from `env`, where the one composer that removes
/// them now lives - the harness inherits the same markers, so the rule cannot belong
/// to this runner alone.
pub use crate::env::CONSOLE_VARIABLES;

/// The command that runs an entry point the way the panel needs it.
///
/// `-NoTerminal` keeps `adapt.cmd` from relaunching into a Windows Terminal window
/// nobody would see, and `-NoPause` keeps it from holding a window open that does
/// not exist. Both are the launcher's own flags, stripped by the entry point
/// before the worker is called.
///
/// `env` is the SAME composed environment the harness is given (`crate::env`), and
/// `home_arguments` is `-DshHome <the chosen home>`: the installer must target the
/// home this app decided on, not whatever the harness would default to. Both entry
/// points accept that spelling, and both fall back to `DSH_HOME` - which the
/// composer also sets - so an installer run by hand and a run from this panel
/// cannot end up in two different homes.
pub fn command_for(
    entry: &Path,
    extra: &[String],
    env: &ChildEnv,
    home_arguments: &[std::ffi::OsString],
) -> Command {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.arg("/c").arg(entry);
        command
    } else {
        let mut command = Command::new("sh");
        command.arg(entry);
        command
    };
    if cfg!(windows) {
        command.arg("-NoTerminal");
    }
    command.arg("-NoPause");
    command.args(home_arguments);
    command.args(extra);
    env.apply(&mut command);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

/// What a setup run is doing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupStatus {
    pub kind: Option<SetupKind>,
    pub running: bool,
    /// The exit code of the last run that finished.
    pub exit: Option<i32>,
    /// The last thing worth saying, in words that are safe to draw.
    pub detail: Option<String>,
}

impl Default for SetupStatus {
    fn default() -> Self {
        SetupStatus { kind: None, running: false, exit: None, detail: None }
    }
}

impl SetupStatus {
    /// One line for the panel's row and for the log.
    pub fn line(&self) -> String {
        match (self.kind, self.running, self.exit) {
            (Some(kind), true, _) => format!("[vncode] {}ing the pack...", kind.label()),
            (Some(kind), false, Some(0)) => {
                format!("[vncode] {} finished successfully", kind.label())
            }
            (Some(kind), false, Some(code)) => {
                format!("[vncode] {} FAILED (exit code {code})", kind.label())
            }
            (Some(kind), false, None) => format!("[vncode] {} did not finish", kind.label()),
            (None, _, _) => "[vncode] the pack has not been installed or removed from here".to_string(),
        }
    }

    pub fn succeeded(&self) -> bool {
        !self.running && self.exit == Some(0)
    }
}

/// The runner: one run at a time, and one writer of the status.
pub struct Setup {
    console: Arc<Console>,
    status: Mutex<SetupStatus>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    running: AtomicBool,
}

impl Setup {
    pub fn new(console: Arc<Console>) -> Self {
        Setup {
            console,
            status: Mutex::new(SetupStatus::default()),
            worker: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> SetupStatus {
        match self.status.lock() {
            Ok(status) => status.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Start an install or an uninstall.
    ///
    /// Returns as soon as the worker is running, like `Supervisor::start`: the
    /// panel follows the status, and the log carries the installer's own words.
    /// `extra` is passed straight through to the entry point - the panel passes
    /// nothing, and `check-shell.mjs` passes `-Help`, which installs nothing and
    /// proves the whole path. `env` and `home_arguments` come from the plan, so the
    /// installer targets the same home the harness will run against.
    pub fn start(
        self: &Arc<Self>,
        kind: SetupKind,
        entry: &Path,
        extra: &[String],
        env: &ChildEnv,
        home_arguments: &[std::ffi::OsString],
    ) -> Result<(), String> {
        if self.is_running() {
            return Err("a setup run is already in flight".to_string());
        }
        if !entry.is_file() {
            return Err(format!("{} is not there any more", entry.display()));
        }
        {
            let mut status = self.status.lock().unwrap_or_else(|error| error.into_inner());
            *status = SetupStatus { kind: Some(kind), running: true, exit: None, detail: None };
        }
        self.running.store(true, Ordering::SeqCst);
        let shell = Arc::clone(self);
        let entry = entry.to_path_buf();
        let extra = extra.to_vec();
        let env = env.clone();
        let home_arguments = home_arguments.to_vec();
        let handle =
            thread::spawn(move || run(shell, kind, &entry, &extra, &env, &home_arguments));
        let mut slot = self.worker.lock().unwrap_or_else(|error| error.into_inner());
        *slot = Some(handle);
        Ok(())
    }

    /// Wait for a run in flight to finish. The panel never calls this (it would
    /// freeze the window); the check does.
    pub fn join(&self) {
        let handle = self.worker.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    fn finish(&self, kind: SetupKind, exit: Option<i32>) {
        {
            let mut status = self.status.lock().unwrap_or_else(|error| error.into_inner());
            status.running = false;
            status.exit = exit;
            status.detail = Some(kind.label().to_string());
        }
        self.running.store(false, Ordering::SeqCst);
    }
}

/// The worker: spawn the entry point, stream both of its streams, record the exit.
fn run(
    shell: Arc<Setup>,
    kind: SetupKind,
    entry: &Path,
    extra: &[String],
    env: &ChildEnv,
    home_arguments: &[std::ffi::OsString],
) {
    let mut command = command_for(entry, extra, env, home_arguments);
    let shown = format!(
        "{} {} {}",
        entry.display(),
        if cfg!(windows) { "-NoTerminal -NoPause" } else { "-NoPause" },
        extra.join(" ")
    );
    shell.console.push(&format!("[vncode] running {}", shown.trim()));
    shell.console.push(&format!("[vncode] installer environment: {}", env.line()));

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            shell.console.push(&format!("[vncode] could not run {}: {error}", entry.display()));
            shell.finish(kind, None);
            return;
        }
    };

    // Both streams are drained for as long as the run lasts: a pipe nobody reads
    // fills up and blocks the process writing to it, which for an installer that
    // has a lot to say is a hang rather than a slow install.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();
    for stream in [stdout.map(Stream::Out), stderr.map(Stream::Err)].into_iter().flatten() {
        let console = Arc::clone(&shell.console);
        readers.push(thread::spawn(move || match stream {
            Stream::Out(reader) => drain(console, reader, false),
            Stream::Err(reader) => drain(console, reader, true),
        }));
    }

    let exit = child.wait().ok().and_then(|status| status.code());
    for reader in readers {
        let _ = reader.join();
    }
    shell.console.push(&SetupStatus {
        kind: Some(kind),
        running: false,
        exit,
        detail: None,
    }
    .line());
    shell.finish(kind, exit);
}

enum Stream {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

fn drain<R: std::io::Read>(console: Arc<Console>, reader: R, is_error: bool) {
    use std::io::{BufRead, BufReader};
    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        // The installer's own errors are kept distinguishable in one transcript,
        // because "which stream said this" is the first question about a failure.
        if is_error {
            console.push(&format!("[stderr] {line}"));
        } else {
            console.push(&line);
        }
    }
}

/// Split the arguments a headless command was given, the way a shell would.
///
/// Whitespace separates, and **double quotes group** - so a path with a space in it
/// can be passed as one argument (`install -DshHome "C:\Users\me\My Home"`). The
/// quotes are not part of the argument. There are no escapes and no single quotes:
/// this exists so that a path with a space WORKS, not so that the shell can be
/// reimplemented, and a command line that needs more than that should be run
/// through the entry point directly.
pub fn split_args(line: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for character in line.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                // An empty quoted argument is an argument: `""` is one thing.
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-setup-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn arguments_split_on_whitespace_and_quotes_group() {
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args("   "), Vec::<String>::new());
        assert_eq!(split_args("-Help"), vec!["-Help"]);
        assert_eq!(split_args("-Force -Plugin pdf"), vec!["-Force", "-Plugin", "pdf"]);
        // The case this exists for: a harness home with a space in it. Measured -
        // the first version passed the quotes through, and PowerShell reported
        // `Cannot find drive. A drive with the name '"C' does not exist.`
        assert_eq!(
            split_args(r#"-DshHome "C:\Users\me\My Home" -Force"#),
            vec!["-DshHome", r"C:\Users\me\My Home", "-Force"]
        );
        assert_eq!(split_args(r#"a "b c"d"#), vec!["a", "b cd"]);
        assert_eq!(split_args(r#"empty "" here"#), vec!["empty", "", "here"]);
    }

    #[test]
    fn the_entry_points_are_found_where_the_tree_puts_them() {
        let root = scratch("locate");
        let setup = root.join("scripts").join("setup");
        std::fs::create_dir_all(&setup).unwrap();
        // Nothing there yet: the panel must be able to say so rather than guess.
        assert_eq!(locate(&root), None);
        for name in ["install.bat", "install.sh", "uninstall.bat", "uninstall.sh"] {
            std::fs::write(setup.join(name), b"rem fixture\n").unwrap();
        }
        let found = locate(&root).expect("both entry points are there");
        let expected_extension = if cfg!(windows) { "bat" } else { "sh" };
        assert!(found.install.ends_with(format!("install.{expected_extension}")));
        assert!(found.uninstall.ends_with(format!("uninstall.{expected_extension}")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_child_environment_drops_every_console_variable() {
        // The trap this pins: the panel is started by the console layer, so it
        // inherits VNCODE_CONSOLE - and an entry point that sees it drops the
        // arguments it was given. Measured on a machine where the first version of
        // the Install button ran a full install while being asked for help.
        unsafe {
            for name in CONSOLE_VARIABLES {
                std::env::set_var(name, "1");
            }
        }
        let env = composed();
        let command = command_for(Path::new("install.bat"), &["-Help".to_string()], &env, &[]);
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().to_string())
            .collect();
        unsafe {
            for name in CONSOLE_VARIABLES {
                std::env::remove_var(name);
            }
        }
        for name in CONSOLE_VARIABLES {
            assert!(
                removed.iter().any(|removed| removed.eq_ignore_ascii_case(name)),
                "{name} was left in the child's environment"
            );
        }
        // ...and the home the app decided reaches the installer as the entry
        // point's own flag, because the harness would otherwise be installed into
        // whatever home it defaults to.
        let env = composed_home("/root/home");
        let command = command_for(
            Path::new("install.bat"),
            &[],
            &env,
            &[std::ffi::OsString::from("-DshHome"), std::ffi::OsString::from("/root/home")],
        );
        let args: Vec<String> =
            command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert!(args.contains(&"-DshHome".to_string()), "{args:?}");
        assert!(args.contains(&"/root/home".to_string()), "{args:?}");
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == "DSH_HOME")
                .and_then(|(_, value)| value)
                .map(|value| value.to_string_lossy().to_string())
                .as_deref(),
            Some("/root/home")
        );
    }

    /// The composer's own output, so these tests exercise the real thing.
    fn composed() -> ChildEnv {
        crate::env::compose(&crate::env::Facts {
            launch: &vn_shell_core::launch::Launch::Npx,
            home: None,
            cache: None,
            workspace: None,
            inherited_path: None,
        })
    }

    fn composed_home(home: &str) -> ChildEnv {
        crate::env::compose(&crate::env::Facts {
            launch: &vn_shell_core::launch::Launch::Npx,
            home: Some(Path::new(home)),
            cache: None,
            workspace: None,
            inherited_path: None,
        })
    }

    #[test]
    fn the_command_keeps_the_console_from_opening_a_window() {
        let extras = vec!["-Help".to_string()];
        let command = command_for(Path::new("install.bat"), &extras, &composed(), &[]);
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(args.iter().any(|arg| arg == "-NoPause"), "{args:?}");
        if cfg!(windows) {
            assert!(args.iter().any(|arg| arg == "-NoTerminal"), "{args:?}");
            assert_eq!(args.first().map(String::as_str), Some("/c"), "{args:?}");
        }
        assert!(args.iter().any(|arg| arg == "-Help"), "the caller's args must survive");
    }

    #[test]
    fn the_status_says_what_happened_in_words() {
        let running =
            SetupStatus { kind: Some(SetupKind::Install), running: true, exit: None, detail: None };
        assert!(running.line().contains("installing"), "{}", running.line());
        let done =
            SetupStatus { kind: Some(SetupKind::Install), running: false, exit: Some(0), detail: None };
        assert!(done.succeeded());
        assert!(done.line().contains("finished successfully"), "{}", done.line());
        let failed =
            SetupStatus { kind: Some(SetupKind::Uninstall), running: false, exit: Some(1), detail: None };
        assert!(!failed.succeeded());
        assert!(failed.line().contains("FAILED (exit code 1)"), "{}", failed.line());
        assert!(SetupStatus::default().line().contains("has not been"));
    }

    #[test]
    fn a_run_that_cannot_start_reports_rather_than_pretends() {
        let console = Arc::new(Console::new());
        let setup = Arc::new(Setup::new(Arc::clone(&console)));
        let missing = scratch("missing").join("install.bat");
        let error = setup
            .start(SetupKind::Install, &missing, &[], &composed(), &[])
            .unwrap_err();
        assert!(error.contains("is not there any more"), "{error}");
        assert!(!setup.is_running());
    }
}
