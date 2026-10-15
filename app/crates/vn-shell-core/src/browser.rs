//! Which browser shows the harness, and how it is started.
//!
//! The app owns the surface but not the renderer: the shipped interface is a web
//! application, and the process that draws it is a browser this app found on the
//! machine. Chrome first, because that is what `scripts\run-web.bat` opens and the
//! two entry points should behave the same way - and **everything else works**,
//! because the last rung is the platform's own opener, which by definition handles a
//! browser this table has never heard of.
//!
//! ## The four rules a launch keeps
//!
//! 1. **The URL is ONE argv element**, never a command string. It carries the launch
//!    token, which is a live credential: a shell in the middle of that is a shell
//!    that can be made to do something else with it.
//! 2. **Only a loopback URL is ever launched.** Checked here as well as at the ready
//!    line - this is the last function before a process starts with that URL in its
//!    argv, and a rule that holds at only one end of a pipe is not a rule.
//! 3. **No shell, anywhere.** `explorer.exe`, `open` and `xdg-open` are programs, not
//!    command lines; the Chrome-family entries are programs.
//! 4. **A spawned process is not a page.** `spawn()` says a process was CREATED and
//!    nothing more, so every rung is watched for one settle window ([`SETTLE`]) and a
//!    program that died on the way up is reported as a failure and falls through to the
//!    next rung - see [`Attempt`] for the measurement that made this a rule.
//!
//! Detection is a pure function of [`Facts`] and one `probe` predicate, so the table
//! and the ORDER in it are `cargo test` cases on every platform, rather than
//! something only a machine with five browsers installed could check.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::urlpolicy;

/// How long a program this app started is given to prove it is a browser.
///
/// A Chromium or Firefox that is ALREADY running is a relay: it hands the URL to the
/// running instance and exits, measured on this repository's own machine at 60-90 ms. A
/// browser that is not running stays alive, because it IS the browser. A program that
/// cannot start exits quickly with a FAILURE status - and this window is what makes that
/// visible, because `spawn()` returning `Ok` says only that the process was CREATED.
pub const SETTLE: Duration = Duration::from_millis(1500);

/// How often the settle loop asks.
const POLL: Duration = Duration::from_millis(25);

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
///
/// A Chromium given a `profile` gets `--user-data-dir=<profile>` in front of the URL, and
/// the URL is still exactly ONE argv element. See [`own_profile_dir`] for why that is the
/// one flag this table adds: it is the difference between a browser that writes its profile
/// wherever the machine's data directory is - which a confinement can refuse, measured as
/// `Crashpad … settings.dat: Access is denied` and exit `0x80000003` - and one that writes
/// it inside this app's own root, where the app has already proved it can write.
pub fn command_with(
    browser: &Browser,
    url: &str,
    profile: Option<&Path>,
) -> Result<Command, String> {
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
            // The profile flag, where the family documents one, and never a guessed flag.
            if browser.family == Family::Chromium {
                if let Some(profile) = profile {
                    command.arg(format!("--user-data-dir={}", profile.display()));
                }
            }
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

/// [`command_with`] with no profile of its own.
pub fn command(browser: &Browser, url: &str) -> Result<Command, String> {
    command_with(browser, url, None)
}

/// Where a browser this app starts keeps its profile when it cannot keep it where it
/// normally would: **inside this app's own root**.
///
/// The measured failure this answers, from a real run of this shell:
/// `Google Chrome exited with status 0x80000003 before it could show the page`, and Chrome's
/// own words were `CreateFile C:\Users\…\AppData\Local\Google\Chrome\User Data\Crashpad\
/// settings.dat: Access is denied`. A session that confines what it starts denies the
/// browser the one directory it cannot work without - and it is the same shape of problem
/// this app already answers for its CHILDREN, which are handed `<app root>/tmp` when the
/// machine's temp is refused. The browser gets the same treatment: a profile under the root
/// the app has proved it can write in, and the person's own Chrome is left completely alone
/// - the retry is a second window, never a second profile in their browser.
pub fn own_profile_dir(app_root: &Path) -> PathBuf {
    app_root.join("browser")
}

/// What one attempt to show the page actually did.
///
/// The distinction exists because `spawn()` is not a page: it says a process was
/// CREATED, and a browser that dies on the way up - a confined parent that denies it its
/// own profile, a broken install - is created just as successfully as one that opens a
/// window. Measured on the machine this was written on: `Command::spawn()` returned `Ok`
/// while Chrome exited `0x80000003` (STATUS_BREAKPOINT) after
/// `Crashpad … settings.dat: Access is denied`, and the panel went on saying
/// "opened in Google Chrome (a new tab)" over a window that never appeared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    /// Still running when the settle window closed: this process IS the browser.
    Running,
    /// Exited ZERO inside the window: a browser that was already running took the URL and
    /// the relay left. Success, and the measured shape of one.
    Handed,
    /// Exited ZERO, but **nothing about this rung's status can be evidence** - the
    /// platform's own opener reports success whether or not a page appears. The walk stops
    /// here only because there is nothing left to try; the panel says exactly this rather
    /// than claiming a tab.
    Unverified,
    /// Exited with a failure status before it could show the page. It did NOT open.
    Died { code: Option<i32> },
}

impl Attempt {
    /// Whether the URL is KNOWN to have reached a browser.
    pub fn took_the_url(self) -> bool {
        matches!(self, Attempt::Running | Attempt::Handed)
    }

    /// What happened, in words, for the panel's log.
    pub fn line(self, label: &str) -> String {
        match self {
            Attempt::Running => format!("started {label}, which is still running"),
            Attempt::Handed => {
                format!("handed the page to {label}, which was already running")
            }
            Attempt::Unverified => format!(
                "asked {label} for the page; it reports success without saying whether a window appeared, so this app cannot tell"
            ),
            Attempt::Died { code } => format!(
                "{label} exited with {} before it could show the page, so no tab was opened",
                match code {
                    // An NTSTATUS failure is printed the way Windows names it, because
                    // `0x80000003` is a sentence a search engine understands and
                    // `-2147483645` is not.
                    Some(code) if code < 0 => format!("status 0x{:08X}", code as u32),
                    Some(code) => format!("exit code {code}"),
                    None => "no exit code at all (killed)".to_string(),
                }
            ),
        }
    }
}

/// What an exited program's status means.
///
/// `verified` is false for a rung whose exit status proves nothing: the platform's own
/// opener is a `rundll32` call that **always exits zero**, whether or not a window
/// appeared - measured on a real run, where the log said `handed the page to the default
/// browser, which was already running` and no page appeared at all. A status that cannot
/// be evidence must not be reported as if it were.
pub fn read_status(code: Option<i32>, verified: bool) -> Attempt {
    match code {
        Some(0) if verified => Attempt::Handed,
        Some(0) => Attempt::Unverified,
        Some(code) => Attempt::Died { code: Some(code) },
        None => Attempt::Died { code: None },
    }
}

/// One way of asking for the page: a program, and whether it is given a profile of its own
/// inside this app's root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rung {
    pub browser: Browser,
    /// `Some` for the retry that gets through a confinement (`own_profile_dir`).
    pub profile: Option<PathBuf>,
}

impl Rung {
    fn plain(browser: Browser) -> Rung {
        Rung { browser, profile: None }
    }

    /// What the panel and the log call this rung.
    pub fn label(&self) -> &'static str {
        self.browser.label
    }
}

/// The rungs a hand-off tries, in order.
///
/// 1. **the browser this run chose**, as the person's own browser - where it normally is;
/// 2. **the same browser with a profile inside this app's root**, when it is a Chromium and
///    an app root exists. This is the rung that answers the measured failure: Chrome exited
///    `0x80000003` because a confinement refused it its own profile directory, and a profile
///    under the root the app has already proved it can write is the one thing that changes;
/// 3. **the platform's own opener**, always last.
///
/// `prefer_profile` moves rung 2 in FRONT of rung 1, and the caller sets it from a
/// measurement rather than a hunch: when this app's own probe of the machine's temp
/// directory was refused, this session confines what the app starts, so the person's own
/// browser profile is already known to be unreachable and a doomed launch is not owed to
/// anybody.
pub fn rungs(chosen: &Browser, profile_dir: Option<&Path>, prefer_profile: bool) -> Vec<Rung> {
    let mut rungs = Vec::new();
    let own = profile_dir
        .filter(|_| chosen.family == Family::Chromium)
        .map(|dir| Rung { browser: chosen.clone(), profile: Some(dir.to_path_buf()) });
    if prefer_profile {
        if let Some(own) = own.clone() {
            rungs.push(own);
        }
    }
    rungs.push(Rung::plain(chosen.clone()));
    if !prefer_profile {
        if let Some(own) = own {
            rungs.push(own);
        }
    }
    if !chosen.is_default() {
        rungs.push(Rung::plain(Browser::default_opener()));
    }
    rungs
}

/// What a whole hand-off did: one line per rung, and which one took the URL.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HandOff {
    /// The browser that took the URL, when one did.
    pub took: Option<&'static str>,
    /// Whether the rung that took it was given a profile inside this app's own root.
    pub own_profile: bool,
    /// One line per rung, in the order they were tried - the panel's log.
    pub lines: Vec<String>,
    /// Why nothing took it, when nothing did.
    pub problem: Option<String>,
}

impl HandOff {
    pub fn ok(&self) -> bool {
        self.took.is_some()
    }

    /// The sentence a reader gets when the page did not reach a browser.
    pub fn refusal(&self) -> String {
        let tried: Vec<String> = self.lines.clone();
        format!(
            "{} - no browser took the page: {}",
            self.problem.as_deref().unwrap_or("every browser this app knows refused the page"),
            tried.join("; ")
        )
    }
}

/// Start `browser` on `url`, and watch it long enough to tell a browser from a program
/// that died on the way up.
///
/// The URL still leaves as ONE argv element of a program, never through a shell, and the
/// loopback rule is checked again inside [`command_with`] - this function only adds the
/// measurement the old one was missing.
pub fn attempt(rung: &Rung, url: &str, settle: Duration) -> Result<Attempt, String> {
    let watched = rung.browser.label;
    let mut child = command_with(&rung.browser, url, rung.profile.as_deref())?
        .spawn()
        .map_err(|error| format!("could not start {watched}: {error}"))?;
    // A rung whose exit status is evidence: a browser's relay exit means the running
    // instance took the URL, and the platform's opener has no such meaning.
    let verified = !rung.browser.is_default();
    let deadline = Instant::now() + settle;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(read_status(status.code(), verified)),
            Ok(None) => {}
            Err(error) => return Err(format!("could not watch {watched}: {error}")),
        }
        if Instant::now() >= deadline {
            // Still alive: it is the browser. The handle is dropped and the process is
            // left alone - `Child` has no `Drop` that kills, which is exactly what is
            // wanted here.
            return Ok(Attempt::Running);
        }
        std::thread::sleep(POLL);
    }
}

/// Walk the rungs until one takes the URL, with the runner passed in.
///
/// Split from [`hand_off`] so the LADDER - the order, the stop, the profile retry and what
/// is reported when every rung refuses - is a `cargo test` case rather than a reading of
/// the spawn site.
pub fn walk(
    chosen: &Browser,
    profile_dir: Option<&Path>,
    prefer_profile: bool,
    mut run: impl FnMut(&Rung) -> Result<Attempt, String>,
) -> HandOff {
    let mut report = HandOff::default();
    for rung in rungs(chosen, profile_dir, prefer_profile) {
        match run(&rung) {
            Ok(attempt) => {
                report.lines.push(attempt.line(rung.label()));
                if attempt.took_the_url() {
                    report.took = Some(rung.label());
                    report.own_profile = rung.profile.is_some();
                    return report;
                }
                // An UNVERIFIED rung is the last one that can be tried - the opener is the
                // floor - so the walk ends with the honest "cannot tell" rather than with a
                // claim. Nothing left to try means nothing left to say.
                if attempt == Attempt::Unverified && rung.browser.is_default() {
                    report.took = None;
                    report.problem = Some(format!(
                        "{} could not show the page, and the platform's own opener reports success without telling this app whether a window appeared",
                        chosen.label
                    ));
                    return report;
                }
            }
            Err(error) => report.lines.push(error),
        }
    }
    report.problem = Some(format!(
        "{} could not show the page, and neither could the platform's own opener",
        chosen.label
    ));
    report
}

/// Show `url` in the chosen browser, falling through to a profile of this app's own and
/// then to the platform's opener.
///
/// **Why a fall-through rather than one program.** A browser started as a raw child of a
/// confined process is a browser the confinement can refuse: measured on a real run, Chrome
/// exited `0x80000003` after `Access is denied` on its own profile directory - and the same
/// Chrome, given a profile inside the root this app has proved it can write, is a different
/// proposition. One rung that dies is therefore not the end of the road, and a rung that
/// dies is never reported as a tab that opened.
pub fn hand_off(
    chosen: &Browser,
    url: &str,
    profile_dir: Option<&Path>,
    prefer_profile: bool,
    settle: Duration,
) -> HandOff {
    walk(chosen, profile_dir, prefer_profile, |rung| attempt(rung, url, settle))
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
            // NOT `explorer.exe`, which is unreliable from a non-interactive child -
            // measured: a button that spawned it appeared to do nothing.
            "rundll32.exe"
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

    // -----------------------------------------------------------------------
    // A spawned process is not a page
    // -----------------------------------------------------------------------

    fn chrome() -> Browser {
        Browser {
            id: "chrome",
            label: "Google Chrome",
            family: Family::Chromium,
            program: Some(PathBuf::from("chrome")),
        }
    }

    #[test]
    fn a_relay_that_left_cleanly_took_the_url_and_a_crash_did_not() {
        // The measured pair: a browser that was already running exits 0, and the Chrome
        // this repository watched die exits 0x80000003 after Crashpad was refused.
        assert_eq!(read_status(Some(0), true), Attempt::Handed);
        assert!(read_status(Some(0), true).took_the_url());
        assert_eq!(
            read_status(Some(0x80000003u32 as i32), true),
            Attempt::Died { code: Some(-2147483645) }
        );
        assert!(!read_status(Some(0x80000003u32 as i32), true).took_the_url());
        assert!(!read_status(Some(101), true).took_the_url(), "a non-zero exit is never a tab");
        assert!(!read_status(None, true).took_the_url());
        // The words a person reads, and the reason the high half is printed as hex.
        let line = read_status(Some(0x80000003u32 as i32), true).line("Google Chrome");
        assert!(line.contains("0x80000003"), "{line}");
        assert!(line.contains("no tab was opened"), "{line}");
        assert!(read_status(Some(0), true).line("Google Chrome").contains("already running"));
    }

    #[test]
    fn the_platform_opener_reports_success_it_cannot_back_up() {
        // MEASURED, from a real run: `rundll32 url.dll,FileProtocolHandler <url>` exits
        // ZERO whether or not a window appears - the log said "handed the page to the
        // default browser, which was already running" over a screen with nothing on it. A
        // status that cannot be evidence is not reported as one, and the walk does not
        // claim a tab for it.
        let unverified = read_status(Some(0), false);
        assert_eq!(unverified, Attempt::Unverified);
        assert!(!unverified.took_the_url());
        let line = unverified.line("the default browser");
        assert!(line.contains("cannot tell"), "{line}");
        // ...and a FAILURE status from the opener is still a failure.
        assert_eq!(read_status(Some(1), false), Attempt::Died { code: Some(1) });
    }

    #[test]
    fn a_rung_that_died_falls_through_to_the_profile_of_this_apps_own() {
        // The measured failure this rung exists for: Chrome dies on its OWN profile
        // directory, and the same Chrome given one inside this app's root is a different
        // proposition. The walk stops at the first rung that takes the URL.
        let mut tried: Vec<(String, bool)> = Vec::new();
        let report = walk(&chrome(), Some(Path::new("/root/browser")), false, |rung| {
            tried.push((rung.browser.id.to_string(), rung.profile.is_some()));
            if rung.profile.is_some() {
                Ok(Attempt::Running)
            } else {
                Ok(Attempt::Died { code: Some(0x80000003u32 as i32) })
            }
        });
        assert_eq!(
            tried,
            vec![("chrome".to_string(), false), ("chrome".to_string(), true)],
            "the person's own browser first, then one with a profile of ours"
        );
        assert!(report.ok());
        assert_eq!(report.took, Some("Google Chrome"));
        assert!(report.own_profile, "the row must say the window is this app's own");
        assert_eq!(report.lines.len(), 2, "{:?}", report.lines);
        assert!(report.lines[1].contains("still running"), "{:?}", report.lines);
    }

    #[test]
    fn a_confined_session_is_offered_the_profile_of_our_own_first() {
        // `prefer_profile` is set from a measurement - this app's own temp probe was
        // refused - so the person's profile is already known to be unreachable and a
        // doomed launch is not owed to anybody.
        let ladder = super::rungs(&chrome(), Some(Path::new("/root/browser")), true);
        assert_eq!(ladder.len(), 3, "{ladder:?}");
        assert!(ladder[0].profile.is_some(), "the profile of our own comes first");
        assert!(ladder[1].profile.is_none());
        assert!(ladder[2].browser.is_default());
        // The ordinary order, when nothing measured a confinement.
        let ladder = super::rungs(&chrome(), Some(Path::new("/root/browser")), false);
        assert!(ladder[0].profile.is_none());
        assert!(ladder[1].profile.is_some());
        assert!(ladder[2].browser.is_default());
    }

    #[test]
    fn only_a_chromium_is_given_a_profile_flag_and_the_url_stays_one_argument() {
        // The flag goes where the family documents one - Chrome and its relatives - and
        // the URL is STILL exactly one argv element, which is the rule that carries the
        // launch token.
        let url = "http://127.0.0.1:3080/?token=x";
        let built = command_with(&chrome(), url, Some(Path::new(r"C:\root\browser"))).unwrap();
        let args: Vec<String> =
            built.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert_eq!(args.len(), 2, "{args:?}");
        assert_eq!(args[0], r"--user-data-dir=C:\root\browser");
        assert_eq!(args[1], url, "the URL must still be exactly one argument");

        // Firefox has no such flag in this table, so it is never given one.
        let firefox = Browser {
            id: "firefox",
            label: "Mozilla Firefox",
            family: Family::Firefox,
            program: Some(PathBuf::from("firefox")),
        };
        let built = command_with(&firefox, url, Some(Path::new("/root/browser"))).unwrap();
        let args: Vec<String> =
            built.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec![url.to_string()], "{args:?}");

        // ...and the floor never takes one either: it is handed a URL, not a browser.
        let built = command_with(&Browser::default_opener(), url, Some(Path::new("/root/b")))
            .unwrap();
        let args: Vec<String> =
            built.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert!(args.iter().all(|arg| !arg.starts_with("--user-data-dir")), "{args:?}");
        assert_eq!(args.last().map(String::as_str), Some(url));

        // The loopback rule still holds with a profile in front of the URL.
        assert!(command_with(&chrome(), "http://evil.example/", Some(Path::new("/root/b"))).is_err());
    }

    #[test]
    fn the_profile_this_app_offers_lives_inside_its_own_root() {
        let dir = own_profile_dir(Path::new("/root"));
        assert_eq!(dir, Path::new("/root").join("browser"));
        assert!(dir.starts_with("/root"), "the browser writes where the app can: {}", dir.display());
    }

    #[test]
    fn a_rung_that_died_falls_through_to_the_platforms_own_opener() {
        // The rung that DIED is not the end of the road: the floor is tried, and the
        // report names the browser that really took the URL.
        let mut tried: Vec<&'static str> = Vec::new();
        let report = walk(&chrome(), None, false, |rung| {
            tried.push(rung.browser.id);
            if rung.browser.is_default() {
                Ok(Attempt::Running)
            } else {
                Ok(Attempt::Died { code: Some(0x80000003u32 as i32) })
            }
        });
        assert_eq!(tried, vec!["chrome", "default"], "the floor must be the last rung");
        assert!(report.ok());
        assert_eq!(report.took, Some("the default browser"));
        assert_eq!(report.lines.len(), 2);
        assert!(report.lines[0].contains("no tab was opened"), "{:?}", report.lines);
        assert!(report.lines[1].contains("still running"), "{:?}", report.lines);
    }

    #[test]
    fn the_first_rung_that_takes_the_url_ends_the_walk() {
        let mut tried: Vec<&'static str> = Vec::new();
        let report = walk(&chrome(), None, false, |rung| {
            tried.push(rung.browser.id);
            Ok(Attempt::Handed)
        });
        assert_eq!(tried, vec!["chrome"], "a working rung must not be followed by another tab");
        assert_eq!(report.took, Some("Google Chrome"));
        // A refusal to start at all is a rung that failed, not an error out of the walk.
        let report = walk(&chrome(), None, false, |rung| {
            if rung.browser.is_default() {
                Ok(Attempt::Handed)
            } else {
                Err("could not start Google Chrome: access is denied".to_string())
            }
        });
        assert!(report.ok());
        assert!(report.lines[0].contains("access is denied"), "{:?}", report.lines);
    }

    #[test]
    fn a_chosen_default_opener_is_not_tried_twice() {
        let floor = super::rungs(&Browser::default_opener(), None, false);
        assert_eq!(floor.len(), 1, "the floor must not be followed by itself");
        let ladder = super::rungs(&chrome(), None, false);
        assert_eq!(ladder.len(), 2);
        assert!(ladder[1].browser.is_default());
        // Every rung the walk tries is a real one, in the table's own order.
        let (facts, programs) = windows();
        let detected = detect_with(&facts, &present(&programs));
        assert_eq!(super::rungs(&detected[1], None, false)[0].browser.id, "firefox");
    }

    #[test]
    fn nothing_taking_the_url_is_reported_with_every_rung_it_tried() {
        let report = walk(&chrome(), None, false, |_rung| Ok(Attempt::Died { code: Some(5) }));
        assert!(!report.ok());
        assert_eq!(report.took, None);
        let refusal = report.refusal();
        assert!(refusal.contains("Google Chrome"), "{refusal}");
        assert!(refusal.contains("platform's own opener"), "{refusal}");
        // Each rung's own sentence survives into the refusal, so the reader can see
        // that BOTH were tried.
        assert_eq!(refusal.matches("no tab was opened").count(), 2, "{refusal}");
    }

    #[test]
    fn an_opener_that_reports_success_over_nothing_is_never_called_a_tab() {
        // The real run this pins: Chrome died, the opener exited 0, and the panel said
        // "opened ... in the default browser" while the screen stayed empty. The walk now
        // ends in a refusal that names what could NOT be verified.
        let report = walk(&chrome(), Some(Path::new("/root/browser")), true, |rung| {
            if rung.browser.is_default() {
                Ok(Attempt::Unverified)
            } else {
                Ok(Attempt::Died { code: Some(0x80000003u32 as i32) })
            }
        });
        assert!(!report.ok(), "an unverifiable opener is not a tab");
        assert_eq!(report.took, None);
        let refusal = report.refusal();
        assert!(refusal.contains("reports success without telling this app"), "{refusal}");
        assert_eq!(report.lines.len(), 3, "all three rungs were tried: {:?}", report.lines);
    }
}
