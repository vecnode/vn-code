//! The child's environment, composed rather than inherited.
//!
//! This is the rule that closes a whole family of bugs, and this codebase learned it
//! the hard way: the panel is started BY `scripts\run-desktop.bat`, so it inherits
//! that console layer's markers (`VNCODE_CONSOLE`, `VNCODE_ARGV`, …), and an entry
//! point that sees `VNCODE_CONSOLE` does not take its arguments from `%*` - measured,
//! because the first version of the Install button ran a full install while being
//! asked for help. Its first fix removed those variables from the installer's
//! environment only. M0 makes it ONE rule for every child this app starts: the
//! harness, the installer, and (for the browser) the OS itself.
//!
//! | variable | value | why |
//! |---|---|---|
//! | `DSH_HOME` | the chosen home, always | the child's home must be a fact, not an inference. The harness's own resolver is not consulted: it is TOLD |
//! | `npm_config_cache` | the cache chosen by write probe | an npm cache this account cannot write in fails the whole install with `EPERM`, and the advice that follows ("run as Administrator") is what created it |
//! | `PATH` | the vendored runtime's `node` directory first | anything the harness or a skill spawns resolves the same Node the harness runs on |
//! | `TMP`, `TEMP`, `TMPDIR` | `<app root>/tmp`, but **only** when the machine's own temp is not writable by a child | measured, from a real run's log: `dsh-spill-local: EPERM … mkdtemp 'C:\Users\…\AppData\Local\Temp\dsh-spill-XXXXXX'` - the child inherited a temp directory the confinement does not grant it, and the row that owned it did not activate. The machine's temp is left alone whenever it works, because it is the machine's |
//! | `VNCODE_HOME` | **removed** | the app's own word for its root. The harness knows `DSH_HOME` and nothing else; a second spelling would invite a plugin to depend on it - and an inherited one would leak this app's private layout into the child. A check reads this back out of the CHILD, which is how the leak was caught |
//! | `VNCODE_CONSOLE` and the six other console markers | removed | they belong to the launcher's console layer, not to a child of this app |
//! | `npm_config_cache` | removed when no cache was usable | "no writable cache was found" must mean npm uses its own default, not whatever the parent happened to export |
//!
//! What is NOT removed is everything the MACHINE owns: `PATH`, `HOME`, `TEMP`,
//! `SystemRoot`, the proxy variables. Clearing those and rebuilding them from scratch
//! is a much larger promise than composing the variables this app decides, and one
//! that breaks the harness in ways that are hard to diagnose. The rule this module
//! enforces is precise: **every variable this app owns is set or removed
//! deliberately, and the rest is the machine's** - plus one deliberate exception, the
//! `VNCODE_STUB_*` seam, which is read BY the child in a check, is never set by a
//! shipped launcher, and has `scripts/checks/check-shell.mjs` as its only author.
//!
//! The working directory is composed with them (`ChildEnv::apply` sets it): a child
//! that inherits whatever directory the app was launched from is a second, invisible
//! decision - and it is not academic, because `keystate` reads `.env` in the shell's
//! cwd BECAUSE the harness inherits it, so the value the panel reasons about and the
//! value the child is given have to be one value.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use vn_shell_core::appdata::{self, CacheChoice};
use vn_shell_core::launch::{self, Launch};
use vn_shell_core::home;

/// The variables the console layer uses to carry state between an entry point and
/// its relaunched self. None of them may reach a child of this app.
///
/// Kept beside the composer rather than in the installer runner, because the harness
/// is started from the same shell that started the panel and inherits the same
/// markers.
pub const CONSOLE_VARIABLES: [&str; 7] = [
    "VNCODE_CONSOLE",
    "VNCODE_ARGV",
    "VNCODE_ARGS",
    "VNCODE_PAUSE",
    "VNCODE_NOPAUSE",
    "VNCODE_QUIET",
    "VNCODE_NO_WT",
];

/// What a child is given: the pairs set, the names removed, and where it runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChildEnv {
    pairs: Vec<(OsString, OsString)>,
    removed: Vec<OsString>,
    cwd: Option<PathBuf>,
}

impl ChildEnv {
    pub fn pairs(&self) -> &[(OsString, OsString)] {
        &self.pairs
    }

    pub fn removed(&self) -> &[OsString] {
        &self.removed
    }

    pub fn cwd(&self) -> Option<&Path> {
        self.cwd.as_deref()
    }

    /// The value of a variable this composer set.
    pub fn get(&self, name: &str) -> Option<&OsStr> {
        self.pairs
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_os_str())
    }

    /// Put it on a command.
    pub fn apply(&self, command: &mut Command) {
        for (name, value) in &self.pairs {
            command.env(name, value);
        }
        for name in &self.removed {
            command.env_remove(name);
        }
        if let Some(cwd) = self.cwd.as_deref() {
            command.current_dir(cwd);
        }
    }

    /// One line for the panel and the log - the composed facts, never a secret.
    pub fn line(&self) -> String {
        let mut parts: Vec<String> = self
            .pairs
            .iter()
            .map(|(name, value)| {
                format!("{}={}", name.to_string_lossy(), value.to_string_lossy())
            })
            .collect();
        parts.push(format!("{} console markers removed", self.removed.len()));
        if let Some(cwd) = self.cwd.as_deref() {
            parts.push(format!("cwd={}", cwd.display()));
        }
        parts.join(" · ")
    }
}

/// Everything the composer needs, as plain values - so the composition is a `cargo
/// test` case and not a reading of the spawn site.
pub struct Facts<'a> {
    pub launch: &'a Launch,
    pub home: Option<&'a Path>,
    pub cache: Option<&'a CacheChoice>,
    /// A temp directory to hand the child INSTEAD of the machine's, when the
    /// machine's is not writable by a child ([`choose_temp`]).
    pub temp: Option<&'a Path>,
    pub workspace: Option<&'a Path>,
    /// The `PATH` this app inherited. Passed in rather than read here, so a test can
    /// name one.
    pub inherited_path: Option<&'a OsStr>,
}

/// Compose a child's environment from the plan's facts.
pub fn compose(facts: &Facts<'_>) -> ChildEnv {
    let mut pairs: Vec<(OsString, OsString)> = Vec::new();

    // The home first, and always when there is one: the harness's own resolver must
    // never be the thing that decides where this instance keeps its state.
    if let Some(home) = facts.home {
        pairs.push((OsString::from("DSH_HOME"), home.as_os_str().to_os_string()));
    }

    // The vendored runtime's own Node goes in front of PATH, so a skill that runs
    // `node` gets the one the harness is running on.
    if let Launch::Vendored { node, .. } = facts.launch {
        if let Some(directory) = node.parent() {
            let mut value = OsString::from(directory.as_os_str());
            if let Some(inherited) = facts.inherited_path {
                if !inherited.is_empty() {
                    value.push(if cfg!(windows) { ";" } else { ":" });
                    value.push(inherited);
                }
            }
            pairs.push((OsString::from("PATH"), value));
        }
    }

    if let Some(cache) = facts.cache {
        pairs.push((OsString::from("npm_config_cache"), cache.path.as_os_str().to_os_string()));
    }

    // A temp directory the child can actually write in. All three spellings are set
    // when one is given: the child is a Node program, and `os.tmpdir()` reads
    // `TMPDIR`, then `TMP`, then `TEMP` - a child that found an unwritable one of
    // those would fail exactly the way the spill store did.
    if let Some(temp) = facts.temp {
        for name in ["TMPDIR", "TMP", "TEMP"] {
            pairs.push((OsString::from(name), temp.as_os_str().to_os_string()));
        }
    }

    // The app's own variables go, and so do the console layer's markers. `VNCODE_HOME`
    // is the one that was measured leaking: setting `VNCODE_HOME` for the app left it
    // in the child too, because an environment is inherited unless it is REMOVED - and
    // a harness that can see this app's private layout is a harness one plugin away
    // from depending on it. `check-shell.mjs` reads the child's own answer back.
    let mut removed: Vec<OsString> = vec![OsString::from("VNCODE_HOME")];
    removed.extend(CONSOLE_VARIABLES.iter().map(OsString::from));
    // No usable cache means npm's own default, not an inherited value pointing at the
    // directory this app just refused.
    if facts.cache.is_none() {
        removed.push(OsString::from("npm_config_cache"));
    }

    ChildEnv { pairs, removed, cwd: facts.workspace.map(Path::to_path_buf) }
}

/// The cache this app will hand a child, chosen by writing where npm writes.
///
/// `None` when no candidate was usable, which is reported rather than fatal: npm
/// then falls back to its own default, which may be the very directory this app
/// moved away from.
pub fn choose_cache(
    app_root: Option<&Path>,
    home: Option<&Path>,
    repo_root: Option<&Path>,
) -> (Option<CacheChoice>, Option<String>) {
    let candidates = appdata::npm_cache_candidates(app_root, home, repo_root);
    match appdata::choose_npm_cache(&candidates) {
        Some(choice) => {
            let warning = choice.warning.clone();
            (Some(choice), warning)
        }
        None => (
            None,
            Some(
                "[vncode] warning: no writable npm cache was found, so npm will use its own default - which may be the very directory this shell moved away from".to_string(),
            ),
        ),
    }
}

/// The temp directory a child is given: the machine's when a child can write in it,
/// else `<app root>/tmp`, else nothing (with the reason).
///
/// The probe is the operation itself, done in the directory the child would really
/// use. The machine's temp is preferred and left UNTOUCHED when it works - moving a
/// machine-wide directory on a hunch would put a build's scratch files somewhere
/// nobody expects. It is moved only for the measured case: a confinement that grants
/// this app its own root and denies `%TEMP%` to the process under it.
pub fn choose_temp(
    app_root: Option<&Path>,
    machine: Option<PathBuf>,
    probe: &mut impl FnMut(&Path) -> Result<appdata::Probed, String>,
) -> (Option<PathBuf>, Option<String>) {
    if let Some(machine) = machine.as_deref() {
        if probe(machine).is_ok() {
            return (None, None);
        }
    }
    let Some(app_root) = app_root else {
        return (
            None,
            Some(format!(
                "[vncode] warning: {} is not writable by this account and this app has no root of its own, so the child keeps a temp directory it may not be able to use",
                machine
                    .as_deref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "the machine's temp".to_string())
            )),
        );
    };
    let owned = appdata::owned_temp(app_root);
    match probe(&owned) {
        Ok(_) => (
            Some(owned.clone()),
            Some(format!(
                "[vncode] note: {} is not writable by a child of this app, so the child is given {} for temp instead (the harness's own scratch stores write there)",
                machine
                    .as_deref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "the machine's temp (unset)".to_string()),
                owned.display()
            )),
        ),
        Err(error) => (
            None,
            Some(format!(
                "[vncode] warning: neither the machine's temp nor {} can be written: {error}",
                owned.display()
            )),
        ),
    }
}

/// The plan's own environment, for the harness. One place builds it, so a variable
/// cannot be set for the harness and forgotten for the installer.
pub fn for_plan(plan: &crate::Plan) -> ChildEnv {
    compose(&Facts {
        launch: &plan.launch,
        home: plan.home.home_path(),
        cache: plan.npm_cache.as_ref(),
        temp: plan.temp.as_deref(),
        workspace: plan.workspace.as_deref(),
        inherited_path: std::env::var_os("PATH").as_deref(),
    })
}

/// The home a child is told about, or the reason there is none. Kept here so the
/// harness and the installer cannot disagree.
pub fn home_or_problem(resolved: &home::Resolution) -> Result<PathBuf, String> {
    match resolved.home_path() {
        Some(path) => Ok(path.to_path_buf()),
        None => Err(resolved.problem().unwrap_or_else(|| {
            "no harness home could be decided, so nothing can be started".to_string()
        })),
    }
}

/// The `-DshHome <path>` pair an installer entry point accepts, both spellings being
/// the entry point's own. `None` when the home is the one this app chose for itself
/// only - which never happens: the father always names the home.
pub fn dsh_home_arguments(resolved: &home::Resolution) -> Vec<OsString> {
    match resolved.home_path() {
        Some(path) => vec![OsString::from("-DshHome"), path.as_os_str().to_os_string()],
        None => Vec::new(),
    }
}

/// The launch's own program directory, for the panel's environment row.
pub fn runtime_directory(launch: &Launch) -> Option<PathBuf> {
    match launch {
        Launch::Vendored { node, .. } | Launch::Installed { node, .. } => {
            node.parent().map(Path::to_path_buf)
        }
        Launch::Npx => None,
        Launch::Stub { program, .. } => program.parent().map(Path::to_path_buf),
    }
}

/// The `npx` fallback's spec, so a caller can name it without re-deriving the pin.
pub fn npx_spec(version: &str) -> String {
    format!("{}@{}", launch::PACKAGE, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_line(command: &Command) -> Vec<(String, Option<String>)> {
        command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect()
    }

    fn vendored() -> Launch {
        Launch::Vendored {
            node: PathBuf::from("/rt/win-x64/node/node.exe"),
            bin: PathBuf::from("/rt/win-x64/harness/lib/bin.js"),
        }
    }

    #[test]
    fn the_home_is_always_handed_over_and_the_apps_own_name_never_is() {
        let launch = vendored();
        let cache = CacheChoice { path: PathBuf::from("/root/npm-cache"), warning: None };
        let composed = compose(&Facts {
            launch: &launch,
            home: Some(Path::new("/root/home")),
            cache: Some(&cache),
            temp: None,
            workspace: Some(Path::new("/work")),
            inherited_path: Some(OsStr::new("/usr/bin")),
        });
        assert_eq!(composed.get("DSH_HOME"), Some(OsStr::new("/root/home")));
        assert_eq!(composed.get("npm_config_cache"), Some(OsStr::new("/root/npm-cache")));
        // The app's own word for its root is NOT exported: the harness knows
        // DSH_HOME and nothing else.
        assert_eq!(composed.get("VNCODE_HOME"), None);
        assert_eq!(composed.cwd(), Some(Path::new("/work")));
        // ...and the vendored Node is in front of the inherited PATH.
        let path = composed.get("PATH").expect("a vendored launch prepends its Node");
        assert!(path.to_string_lossy().starts_with("/rt/win-x64/node"), "{path:?}");
        assert!(path.to_string_lossy().contains("/usr/bin"), "{path:?}");
    }

    #[test]
    fn the_console_markers_and_the_apps_own_variables_are_removed_for_every_child() {
        let launch = Launch::Npx;
        let composed = compose(&Facts {
            launch: &launch,
            home: Some(Path::new("/root/home")),
            cache: None,
            temp: None,
            workspace: None,
            inherited_path: None,
        });
        let removed: Vec<String> =
            composed.removed().iter().map(|name| name.to_string_lossy().to_string()).collect();
        for name in CONSOLE_VARIABLES {
            assert!(removed.iter().any(|removed| removed == name), "{name} was left in");
        }
        // The app's own word for its root must not reach the child - measured: it did.
        assert!(removed.iter().any(|name| name == "VNCODE_HOME"), "{removed:?}");
        // ...and with no usable cache, npm's own default is what is left rather than
        // an inherited value pointing at the directory that was refused.
        assert!(removed.iter().any(|name| name == "npm_config_cache"), "{removed:?}");

        // The trap, on a real Command: the variables are REMOVED even though this
        // process has them set.
        let mut command = Command::new("node");
        composed.apply(&mut command);
        let envs = command_line(&command);
        for name in ["VNCODE_CONSOLE", "VNCODE_HOME", "npm_config_cache"] {
            let entry = envs
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .unwrap_or_else(|| panic!("{name} must be named, so it can be removed"));
            assert!(entry.1.is_none(), "{name} would reach the child");
        }
        assert_eq!(
            envs.iter()
                .find(|(name, _)| name == "DSH_HOME")
                .and_then(|(_, value)| value.clone())
                .as_deref(),
            Some("/root/home")
        );
    }

    #[test]
    fn a_non_vendored_launch_leaves_the_inherited_path_alone() {
        let launch = Launch::Installed {
            node: PathBuf::from("node.exe"),
            bin: PathBuf::from("/cache/dsh/lib/bin.js"),
        };
        let composed = compose(&Facts {
            launch: &launch,
            home: None,
            cache: None,
            temp: None,
            workspace: None,
            inherited_path: Some(OsStr::new("/usr/bin")),
        });
        assert_eq!(composed.get("PATH"), None, "a PATH was composed from nothing");
        assert_eq!(composed.get("DSH_HOME"), None, "no home means no export");
    }

    #[test]
    fn the_line_names_what_was_composed_and_never_a_secret() {
        let launch = vendored();
        let composed = compose(&Facts {
            launch: &launch,
            home: Some(Path::new("/root/home")),
            cache: None,
            temp: None,
            workspace: Some(Path::new("/work")),
            inherited_path: None,
        });
        let line = composed.line();
        assert!(line.contains("DSH_HOME=/root/home"), "{line}");
        assert!(line.contains("console markers removed"), "{line}");
        assert!(line.contains("cwd=/work"), "{line}");
    }

    #[test]
    fn a_cache_is_chosen_by_writing_and_a_refusal_is_reported() {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        }
        .join(format!("vncode-env-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // The app's own root, with a cache whose `_cacache` tree is a FILE: the root
        // is writable and npm still cannot write, which is the measured failure this
        // probe exists for.
        let app_root = root.join("app-root");
        let broken = app_root.join("npm-cache");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("_cacache"), b"a file, not a directory").unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let (cache, warning) = choose_cache(Some(&app_root), Some(&home), None);
        let cache = cache.expect("the harness home is a usable cache");
        assert!(cache.path.starts_with(&home), "{}", cache.path.display());
        assert!(warning.is_some(), "the refused candidate must be reported");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_home_arguments_are_the_entry_points_own_spelling() {
        let inputs = home::Inputs {
            data_root: Some(Path::new("/data")),
            ..home::Inputs::default()
        };
        let resolved = home::resolve_with(&inputs, &mut |path| {
            Ok(vn_shell_core::appdata::Probed { path: path.to_path_buf(), created: false })
        });
        let arguments = dsh_home_arguments(&resolved);
        assert_eq!(arguments.len(), 2);
        assert_eq!(arguments[0], OsString::from("-DshHome"));
        // Built through the same join the ladder uses, so this reads the same on
        // Windows as on POSIX.
        let expected = vn_shell_core::appdata::owned_home(&vn_shell_core::appdata::root_in(
            Path::new("/data"),
        ));
        assert_eq!(Path::new(&arguments[1]), expected);
        assert_eq!(home_or_problem(&resolved).unwrap(), expected);
    }

    #[test]
    fn a_temp_directory_is_handed_over_only_when_one_was_chosen() {
        let launch = vendored();
        // No temp chosen: the machine's is the child's, untouched.
        let composed = compose(&Facts {
            launch: &launch,
            home: Some(Path::new("/root/home")),
            cache: None,
            temp: None,
            workspace: None,
            inherited_path: None,
        });
        for name in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(composed.get(name), None, "{name} was set with nothing to set");
        }
        // Chosen: all three spellings, because the child is a Node program and
        // `os.tmpdir()` reads them in that order.
        let composed = compose(&Facts {
            launch: &launch,
            home: Some(Path::new("/root/home")),
            cache: None,
            temp: Some(Path::new("/root/tmp")),
            workspace: None,
            inherited_path: None,
        });
        for name in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(composed.get(name), Some(OsStr::new("/root/tmp")), "{name}");
        }
    }

    #[test]
    fn the_machines_temp_is_left_alone_when_a_child_can_write_in_it() {
        let mut probe = |path: &Path| {
            Ok(vn_shell_core::appdata::Probed { path: path.to_path_buf(), created: false })
        };
        let (temp, note) = choose_temp(
            Some(Path::new("/root")),
            Some(PathBuf::from("/machine/temp")),
            &mut probe,
        );
        assert_eq!(temp, None, "the machine's temp must not be moved on a hunch");
        assert_eq!(note, None);
    }

    #[test]
    fn a_temp_a_child_cannot_write_falls_to_the_apps_own_root_and_says_so() {
        // The measured case: `%TEMP%` refuses the child while the app's own root is
        // writable, and the harness's spill store dies on `mkdtemp` without this.
        let mut probe = |path: &Path| {
            if path == vn_shell_core::appdata::owned_temp(Path::new("/root")) {
                Ok(vn_shell_core::appdata::Probed {
                    path: path.to_path_buf(),
                    created: true,
                })
            } else {
                Err("not writable: access is denied".to_string())
            }
        };
        let (temp, note) = choose_temp(
            Some(Path::new("/root")),
            Some(PathBuf::from("/machine/temp")),
            &mut probe,
        );
        let owned = vn_shell_core::appdata::owned_temp(Path::new("/root"));
        assert_eq!(temp.as_deref(), Some(owned.as_path()));
        let note = note.expect("the move must be reported");
        assert!(note.contains("/machine/temp"), "{note}");
        // Built through the same join the app uses, so this reads the same on Windows.
        assert!(note.contains(&owned.display().to_string()), "{note}");
    }

    #[test]
    fn no_temp_anywhere_is_a_warning_rather_than_a_silent_inheritance() {
        let mut probe = |_path: &Path| Err("not writable: access is denied".to_string());
        let (temp, note) =
            choose_temp(Some(Path::new("/root")), Some(PathBuf::from("/machine/temp")), &mut probe);
        assert_eq!(temp, None);
        assert!(note.expect("a warning is due").contains("neither"), "the warning must say so");
        // ...and with no app root either, the warning still names what was tried.
        let mut probe = |_path: &Path| Err("nope".to_string());
        let (temp, note) = choose_temp(None, Some(PathBuf::from("/machine/temp")), &mut probe);
        assert_eq!(temp, None);
        assert!(note.expect("a warning is due").contains("/machine/temp"));
    }

    #[test]
    fn the_npx_spec_carries_the_pin() {
        assert_eq!(npx_spec("0.2.0-rc.2"), "@deepseek-ai/dsh@0.2.0-rc.2");
    }
}
