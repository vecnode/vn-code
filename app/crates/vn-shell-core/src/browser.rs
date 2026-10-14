//! Which browser shows the harness, and how it is started.
//!
//! The app owns the surface but not the renderer: the shipped interface is a web
//! application, and the process that draws it is a browser this app found on the
//! machine. Chrome first, because that is what `scripts\run-web.bat` opens and the
//! two entry points should behave the same way - and **everything else works**,
//! because the last rung is the platform's own opener, which by definition handles a
//! browser this table has never heard of.
//!
//! ## The three rules a launch keeps
//!
//! 1. **The URL is ONE argv element**, never a command string. It carries the launch
//!    token, which is a live credential: a shell in the middle of that is a shell
//!    that can be made to do something else with it.
//! 2. **Only a loopback URL is ever launched.** Checked here as well as at the ready
//!    line - this is the last function before a process starts with that URL in its
//!    argv, and a rule that holds at only one end of a pipe is not a rule.
//! 3. **No shell, anywhere.** `explorer.exe`, `open` and `xdg-open` are programs, not
//!    command lines; the Chrome-family entries are programs.
//!
//! Detection is a pure function of [`Facts`] and one `probe` predicate, so the table
//! and the ORDER in it are `cargo test` cases on every platform, rather than
//! something only a machine with five browsers installed could check.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::urlpolicy;

/// Which operating system's table to read. Passed in rather than read from `cfg!`
/// inside the table, so a test can check all three on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub fn here() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// What a browser accepts on its command line.
///
/// Today every family takes the URL and nothing else - a URL alone means "open a tab"
/// in both - so this is documentation with teeth: a flag (`--new-tab`,
/// `--incognito`, `--profile-directory`) is only safe where the family says it is,
/// and nothing here guesses at one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    /// Chrome, Edge, Brave, Chromium, Vivaldi, Opera.
    Chromium,
    /// Firefox.
    Firefox,
    /// The platform's own opener: whatever the person set as their default browser,
    /// including one this table has never heard of.
    Default,
}

/// One way to show the page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Browser {
    /// Stable, lower case, safe in a preferences file: `chrome`, `edge`, `default`…
    pub id: &'static str,
    /// What the panel draws.
    pub label: &'static str,
    pub family: Family,
    /// The program, or `None` for [`Family::Default`] (the opener is decided at
    /// launch time, per platform, by [`urlpolicy::opener_command`]).
    pub program: Option<PathBuf>,
}

impl Browser {
    pub fn is_default(&self) -> bool {
        self.family == Family::Default
    }

    /// The rung that is always present, and always last.
    pub fn default_opener() -> Browser {
        Browser {
            id: "default",
            label: "the default browser",
            family: Family::Default,
            program: None,
        }
    }
}

/// Everything a detection reads, so the table can be tested without a machine.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    pub os_windows: bool,
    pub os_macos: bool,
    pub program_files: Option<PathBuf>,
    pub program_files_x86: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub home: Option<PathBuf>,
    /// `PATH`, for the Linux and macOS names and for a Windows install that put
    /// itself on it.
    pub path: Option<OsString>,
}

impl Facts {
    /// The facts of the machine this is running on.
    pub fn from_env() -> Facts {
        fn var(name: &str) -> Option<PathBuf> {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        }
        Facts {
            os_windows: cfg!(windows),
            os_macos: cfg!(target_os = "macos"),
            program_files: var("ProgramFiles"),
            program_files_x86: var("ProgramFiles(x86)"),
            local_app_data: var("LOCALAPPDATA"),
            home: crate::home::home_dir(),
            path: std::env::var_os("PATH").filter(|value| !value.is_empty()),
        }
    }

    /// A facts set for one OS, for tests and for the tables' own checks.
    pub fn for_os(os: Os) -> Facts {
        Facts {
            os_windows: os == Os::Windows,
            os_macos: os == Os::MacOs,
            ..Facts::default()
        }
    }
}

/// One entry in the table: an id, a label, a family, and the places to look.
struct Entry {
    id: &'static str,
    label: &'static str,
    family: Family,
    /// Absolute candidates, in order. `{ROOT}` tokens are substituted from [`Facts`].
    absolute: &'static [&'static str],
    /// Program names to look for on `PATH`.
    on_path: &'static [&'static str],
}

/// The table, the Chrome family first and Firefox after it: the order a person with
/// several browsers gets, and the order `scripts\run-web.bat` already prefers.
const TABLE: &[Entry] = &[
    Entry {
        id: "chrome",
        label: "Google Chrome",
        family: Family::Chromium,
        absolute: &[
            r"{PROGRAM_FILES}\Google\Chrome\Application\chrome.exe",
            r"{PROGRAM_FILES_X86}\Google\Chrome\Application\chrome.exe",
            r"{LOCAL_APP_DATA}\Google\Chrome\Application\chrome.exe",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "{HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ],
        on_path: &["google-chrome", "google-chrome-stable", "chrome"],
    },
    Entry {
        id: "edge",
        label: "Microsoft Edge",
        family: Family::Chromium,
        absolute: &[
            r"{PROGRAM_FILES_X86}\Microsoft\Edge\Application\msedge.exe",
            r"{PROGRAM_FILES}\Microsoft\Edge\Application\msedge.exe",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ],
        on_path: &["microsoft-edge", "microsoft-edge-stable", "msedge"],
    },
    Entry {
        id: "brave",
        label: "Brave",
        family: Family::Chromium,
        absolute: &[
            r"{PROGRAM_FILES}\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"{PROGRAM_FILES_X86}\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"{LOCAL_APP_DATA}\BraveSoftware\Brave-Browser\Application\brave.exe",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ],
        on_path: &["brave-browser", "brave"],
    },
    Entry {
        id: "chromium",
        label: "Chromium",
        family: Family::Chromium,
        absolute: &[
            r"{PROGRAM_FILES}\Chromium\Application\chrome.exe",
            r"{LOCAL_APP_DATA}\Chromium\Application\chrome.exe",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ],
        on_path: &["chromium", "chromium-browser"],
    },
    Entry {
        id: "vivaldi",
        label: "Vivaldi",
        family: Family::Chromium,
        absolute: &[
            r"{LOCAL_APP_DATA}\Vivaldi\Application\vivaldi.exe",
            r"{PROGRAM_FILES}\Vivaldi\Application\vivaldi.exe",
            "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
        ],
        on_path: &["vivaldi", "vivaldi-stable"],
    },
    Entry {
        id: "opera",
        label: "Opera",
        family: Family::Chromium,
        absolute: &[
            r"{LOCAL_APP_DATA}\Programs\Opera\opera.exe",
            r"{PROGRAM_FILES}\Opera\opera.exe",
            "/Applications/Opera.app/Contents/MacOS/Opera",
        ],
        on_path: &["opera"],
    },
    Entry {
        id: "firefox",
        label: "Mozilla Firefox",
        family: Family::Firefox,
        absolute: &[
            r"{PROGRAM_FILES}\Mozilla Firefox\firefox.exe",
            r"{PROGRAM_FILES_X86}\Mozilla Firefox\firefox.exe",
            "/Applications/Firefox.app/Contents/MacOS/firefox",
        ],
        on_path: &["firefox"],
    },
];

/// Substitute the per-machine roots into a template, or `None` when it cannot apply
/// here - an unknown root, or a template belonging to another operating system.
///
/// The OS guards are the point: a Windows install path is never a Linux browser, and
/// a macOS app bundle is never a candidate on Windows. Without them, a table shared
/// by three platforms silently probes paths that cannot exist.
fn expand(template: &str, facts: &Facts) -> Option<PathBuf> {
    let is_macos_template = template.contains(".app/Contents/MacOS");
    let is_windows_template = template.contains('\\');
    if is_macos_template && !facts.os_macos {
        return None;
    }
    if is_windows_template && !facts.os_windows {
        return None;
    }
    let mut text = template.to_string();
    for (token, value) in [
        ("{PROGRAM_FILES_X86}", facts.program_files_x86.as_deref()),
        ("{PROGRAM_FILES}", facts.program_files.as_deref()),
        ("{LOCAL_APP_DATA}", facts.local_app_data.as_deref()),
        ("{HOME}", facts.home.as_deref()),
    ] {
        if let Some(at) = text.find(token) {
            let value = value?;
            text.replace_range(at..at + token.len(), &value.to_string_lossy());
        }
    }
    Some(PathBuf::from(text))
}

/// Every place on `PATH` where `name` could be, in `PATH` order.
fn on_path(name: &str, path: Option<&OsString>, probe: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    for directory in std::env::split_paths(path?) {
        let candidate = directory.join(name);
        if probe(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// The browsers this machine has, Chrome first, with the OS opener always last.
///
/// `probe` answers "may this be run?" - a file that exists, with the executable bit
/// where that means anything ([`is_runnable`]). Tests pass their own, which is what
/// makes the whole table checkable on any host.
pub fn detect_with(facts: &Facts, probe: &dyn Fn(&Path) -> bool) -> Vec<Browser> {
    let mut found = Vec::new();
    for entry in TABLE {
        let mut program = None;
        for template in entry.absolute {
            if let Some(path) = expand(template, facts) {
                if probe(&path) {
                    program = Some(path);
                    break;
                }
            }
        }
        if program.is_none() {
            for name in entry.on_path {
                if let Some(path) = on_path(name, facts.path.as_ref(), probe) {
                    program = Some(path);
                    break;
                }
            }
        }
        if let Some(program) = program {
            found.push(Browser {
                id: entry.id,
                label: entry.label,
                family: entry.family,
                program: Some(program),
            });
        }
    }
    // The floor, and the reason "all other browsers should work" is true rather than
    // hoped for: an opener the OS provides, which knows the browser this table does
    // not.
    found.push(Browser::default_opener());
    found
}

/// The browsers on THIS machine.
pub fn detect() -> Vec<Browser> {
    detect_with(&Facts::from_env(), &is_runnable)
}

/// Whether a program can be run: it exists, and on Unix it is executable.
pub fn is_runnable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

/// The browser this run will use: the remembered one when it is still here, else the
/// first detected (Chrome when there is one), else the OS opener.
///
/// A remembered browser that has since been uninstalled is NOT an error - it falls
/// through, and the caller may say so. Refusing to show the page because somebody
/// uninstalled Chrome would be a worse app than one that opens Firefox.
pub fn resolve(preferred: Option<&str>, detected: &[Browser]) -> Browser {
    if let Some(id) = preferred.map(str::trim).filter(|id| !id.is_empty()) {
        if let Some(browser) = detected.iter().find(|browser| browser.id == id) {
            return browser.clone();
        }
    }
    detected.first().cloned().unwrap_or_else(Browser::default_opener)
}

/// The command that shows `url`, or the reason it may not be shown.
pub fn command(browser: &Browser, url: &str) -> Result<Command, String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("'{url}' is not a URL: {error}"))?;
    if !urlpolicy::is_internal(&parsed) {
        return Err(format!(
            "refusing to open {}: only a loopback URL may be shown by this app",
            parsed.host_str().unwrap_or("that address")
        ));
    }
    let mut command = match browser.family {
        Family::Default => urlpolicy::opener_command(url),
        _ => {
            let program = browser
                .program
                .as_ref()
                .ok_or_else(|| format!("{} has no program to run", browser.label))?;
            let mut command = Command::new(program);
            // ONE argv element. Nothing here is a command string.
            command.arg(url);
            command
        }
    };
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    Ok(command)
}

/// Start the browser. Returns the label that was used, for the panel to draw.
pub fn launch(browser: &Browser, url: &str) -> Result<&'static str, String> {
    command(browser, url)?
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", browser.label))?;
    Ok(browser.label)
}

/// The stable ids this build knows, for validating a preferences file.
pub fn known_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = TABLE.iter().map(|entry| entry.id).collect();
    ids.push("default");
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Windows machine with Chrome and Firefox, and nothing else.
    fn windows() -> (Facts, Vec<PathBuf>) {
        let program_files = PathBuf::from(r"C:\Program Files");
        let chrome = program_files.join(r"Google\Chrome\Application\chrome.exe");
        let firefox = program_files.join(r"Mozilla Firefox\firefox.exe");
        let facts = Facts {
            os_windows: true,
            os_macos: false,
            program_files: Some(program_files),
            program_files_x86: Some(PathBuf::from(r"C:\Program Files (x86)")),
            local_app_data: Some(PathBuf::from(r"C:\Users\me\AppData\Local")),
            home: Some(PathBuf::from(r"C:\Users\me")),
            path: Some(OsString::from(r"C:\Windows\system32")),
        };
        (facts, vec![chrome, firefox])
    }

    fn present(programs: &[PathBuf]) -> impl Fn(&Path) -> bool + '_ {
        move |path: &Path| programs.iter().any(|program| program == path)
    }

    #[test]
    fn chrome_comes_first_and_the_default_opener_is_always_last() {
        let (facts, programs) = windows();
        let detected = detect_with(&facts, &present(&programs));
        let ids: Vec<&str> = detected.iter().map(|browser| browser.id).collect();
        assert_eq!(ids, vec!["chrome", "firefox", "default"], "{ids:?}");
        assert!(detected.last().unwrap().is_default(), "the floor must be the last rung");
        assert!(!detected[0].is_default(), "Chrome must win when it is installed");
    }

    #[test]
    fn a_machine_with_no_browser_at_all_still_has_the_floor() {
        // The promise "all other browsers should work": an unknown browser is the
        // OS's business, and the app never refuses to show the page because its own
        // table does not know the program.
        let (facts, _) = windows();
        let detected = detect_with(&facts, &|_path| false);
        assert_eq!(detected.len(), 1);
        assert!(detected[0].is_default());
        let browser = resolve(Some("chrome"), &detected);
        assert!(browser.is_default(), "an uninstalled Chrome must fall through, not refuse");
    }

    #[test]
    fn a_remembered_browser_is_used_and_an_unknown_id_falls_back() {
        let (facts, programs) = windows();
        let detected = detect_with(&facts, &present(&programs));
        assert_eq!(resolve(Some("firefox"), &detected).id, "firefox");
        assert_eq!(resolve(Some("  firefox  "), &detected).id, "firefox");
        // Nothing remembered: the first detected, which is Chrome when there is one.
        assert_eq!(resolve(None, &detected).id, "chrome");
        assert_eq!(resolve(Some("netscape"), &detected).id, "chrome");
        assert_eq!(resolve(Some(""), &detected).id, "chrome");
        assert_eq!(resolve(Some("chrome"), &[]).id, "default");
    }

    #[test]
    fn path_lookup_finds_a_linux_browser_and_no_other_os_leaks_in() {
        // `PATH` is the HOST's, so the separator is the host's too - the table is
        // what is being tested for OS-correctness here, not the variable's syntax.
        let separator = if cfg!(windows) { ";" } else { ":" };
        let joined = format!("/usr/bin{separator}/opt/weird/bin");
        let facts = Facts {
            path: Some(OsString::from(joined)),
            ..Facts::for_os(Os::Linux)
        };
        let wanted = PathBuf::from("/opt/weird/bin/brave-browser");
        let detected = detect_with(&facts, &|candidate| candidate == wanted);
        assert_eq!(detected[0].id, "brave");
        assert_eq!(detected[0].program.as_deref(), Some(wanted.as_path()));
        // ...and a macOS app bundle is never a Linux candidate, whatever exists.
        let detected = detect_with(&facts, &|candidate| {
            candidate.to_string_lossy().contains("Google Chrome.app")
        });
        assert_eq!(detected.len(), 1, "a macOS app bundle was detected on Linux");
        assert!(detected[0].is_default());
        // A Windows template is never a candidate off Windows either.
        let detected = detect_with(&Facts::for_os(Os::MacOs), &|candidate| {
            candidate.to_string_lossy().contains(r"Google\Chrome")
        });
        assert_eq!(detected.len(), 1, "a Windows install path was detected on macOS");
    }

    #[test]
    fn a_macos_bundle_is_found_with_a_home_relative_application() {
        let home = PathBuf::from("/Users/me");
        let bundle = home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        let facts = Facts { home: Some(home), ..Facts::for_os(Os::MacOs) };
        let detected = detect_with(&facts, &|candidate| candidate == bundle);
        assert_eq!(detected[0].id, "chrome");
        assert_eq!(detected[0].program.as_deref(), Some(bundle.as_path()));
    }

    #[test]
    fn the_url_is_one_argv_element_and_the_default_opener_is_a_program() {
        let chrome = Browser {
            id: "chrome",
            label: "Google Chrome",
            family: Family::Chromium,
            program: Some(PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe")),
        };
        let url = "http://127.0.0.1:3080/?token=a-secret";
        let built = command(&chrome, url).unwrap();
        let args: Vec<String> =
            built.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec![url.to_string()], "the URL must be exactly one argument");
        assert_eq!(
            built.get_program().to_string_lossy(),
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        );

        // The floor runs the OS's own opener, and it is still a program, not a shell.
        let floor = command(&Browser::default_opener(), url).unwrap();
        let program = floor.get_program().to_string_lossy().to_string();
        let expected = if cfg!(windows) {
            "explorer.exe"
        } else if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        assert_eq!(program, expected);
    }

    #[test]
    fn only_a_loopback_url_may_be_launched() {
        let chrome = Browser {
            id: "chrome",
            label: "Google Chrome",
            family: Family::Chromium,
            program: Some(PathBuf::from("chrome")),
        };
        for refused in [
            "http://evil.example/?token=x",
            "https://127.0.0.1.evil.example/",
            "file:///etc/passwd",
            "not a url at all",
        ] {
            assert!(command(&chrome, refused).is_err(), "{refused} was accepted");
        }
        // The loopback spellings are all fine.
        for allowed in ["http://127.0.0.1:3080/?token=x", "http://localhost:3080/"] {
            assert!(command(&chrome, allowed).is_ok(), "{allowed} was refused");
        }
    }

    #[test]
    fn a_browser_with_no_program_is_never_run_directly() {
        let broken = Browser {
            id: "chrome",
            label: "Google Chrome",
            family: Family::Chromium,
            program: None,
        };
        let error = command(&broken, "http://127.0.0.1:3080/").unwrap_err();
        assert!(error.contains("no program"), "{error}");
    }

    #[test]
    fn the_known_ids_are_safe_for_a_preferences_file() {
        for id in known_ids() {
            assert!(
                id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'),
                "{id} is not a safe id"
            );
        }
        assert!(known_ids().contains(&"default"));
        assert!(known_ids().contains(&"chrome"));
    }
}
