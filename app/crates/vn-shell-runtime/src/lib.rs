//! The supervisor: everything that owns a process.
//!
//! One thread owns one child. The panel does not kill anything itself and does not
//! write the status itself - it sends an ORDER and reads what the worker recorded.
//! That is the whole design, and it is why there is exactly one writer of
//! [`Status`]: two writers would be two answers to "is it running", and the panel
//! would eventually disagree with the process table.
//!
//! The lifetime this implements is the one docs/PLAN-egui-shell.md describes:
//!
//! ```text
//! open        nothing is spawned, nothing is bound, no pane exists
//! Start       choose the port, spawn, watch the ready line (90 s)
//! Running     the URL is known; the pane or the browser shows it
//! Stop        the WHOLE tree dies, and the port is then CHECKED, not assumed
//! ```

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use url::Url;
use vn_shell_core::status::{Phase, Status};
use vn_shell_core::{home, keystate, launch, options::Options, ports, readyline};

pub mod adopt;
pub mod console;
pub mod env;
pub mod setup;
pub mod view;

pub use adopt::{Adopt, AdoptState};
pub use console::Console;
pub use env::ChildEnv;
pub use setup::{EntryPoints, Setup, SetupKind, SetupStatus};
pub use view::View;

/// How long to wait for the ready line.
///
/// Generous on purpose, and this number is about the SLOW path: with no vendored
/// runtime, the first launch of a pin downloads the whole harness closure through
/// npx before a server exists. Ninety seconds was the old launcher's number and it
/// is tight for a cold fetch on an ordinary connection; three minutes is not a
/// hang, and it is not a wait anybody is trapped in either - the panel shows the
/// installer's and npm's output as it arrives, and Stop works during it.
pub const READY_TIMEOUT: Duration = Duration::from_secs(180);

/// How often the worker looks at the child, and how long the panel may go without
/// a repaint of the status.
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// How long a stopped tree is given to die before it is killed outright.
pub const STOP_GRACE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// The plan: what Start will do, decided before anything is spawned
// ---------------------------------------------------------------------------
/// Everything the panel shows before Start, and everything Start then acts on.
#[derive(Clone, Debug)]
pub struct Plan {
    pub version: String,
    pub launch: launch::Launch,
    /// Where the app's root and the harness home are, and what had to be refused.
    /// Since M0 this is a ladder's answer rather than an inherited path.
    pub home: home::Resolution,
    /// The npm cache a child is given, chosen by writing where npm really writes.
    pub npm_cache: Option<vn_shell_core::appdata::CacheChoice>,
    /// A temp directory to hand the child instead of the machine's - set only when a
    /// child cannot write in the machine's (`env::choose_temp`), which the harness's
    /// own spill store proved it sometimes cannot.
    pub temp: Option<PathBuf>,
    /// The directory the harness will run in, captured once. It is composed into
    /// the child, because `keystate` reads `.env` in the shell's cwd BECAUSE the
    /// harness inherits it - so one value has to serve both.
    pub workspace: Option<PathBuf>,
    /// The checkout or distribution root, when one was found. Carried here so the
    /// launch decision and the npm-cache choice see the same facts.
    pub root: Option<PathBuf>,
    /// What [`ports::choose_port`] answers right now. A HINT: Start really does
    /// choose again, because a port that was free when the panel opened may be
    /// held by the time Start is pressed.
    pub port_hint: Option<u16>,
    /// Lines worth printing and worth showing in the panel: a refused home, a
    /// missing pack, a half-vendored runtime, a cache that had to move.
    pub notes: Vec<String>,
}

impl Plan {
    /// The harness home, when the ladder decided one.
    pub fn home_path(&self) -> Option<&Path> {
        self.home.home_path()
    }

    /// The app's own root - what the panel's `vncode` row draws.
    pub fn app_root(&self) -> Option<&Path> {
        self.home.app_root_path()
    }

    /// The composed environment, as one line. What the panel's `harness env` row
    /// draws, and what the log records before a child is spawned.
    pub fn env_line(&self) -> String {
        env::for_plan(self).line()
    }

    /// The app root's own words, for the panel's `vncode` row.
    pub fn app_root_origin_label(&self) -> &'static str {
        self.home.app_root_origin_label()
    }

    /// Whether the home in use was created by this app - the panel says so, because
    /// "I made this" and "I joined this" are different promises.
    pub fn home_created(&self) -> bool {
        self.home.home_created()
    }

    /// The home somebody chose in this panel, when there is one, so a Start can be
    /// given it without the panel re-reading its own preferences file.
    pub fn remembered_home(&self) -> Option<&Path> {
        self.home
            .home
            .as_ref()
            .filter(|selection| selection.origin == home::Origin::Remembered)
            .map(|selection| selection.chosen.as_path())
    }
}

impl Plan {
    /// One line naming what will actually run - never what was hoped for.
    pub fn runtime_line(&self) -> String {
        match &self.launch {
            launch::Launch::Vendored { node, .. } => {
                format!("vendored runtime ({})", node.display())
            }
            launch::Launch::Installed { bin, .. } => {
                format!("already installed here, no npm ({})", bin.display())
            }
            launch::Launch::Npx => format!("npx --yes @deepseek-ai/dsh@{}", self.version),
            launch::Launch::Stub { program, .. } => {
                format!("TEST SEAM ({})", program.display())
            }
        }
    }

    /// How the harness will be started, in the words the panel and the console
    /// both use.
    pub fn start_line(&self, port: u16) -> String {
        match &self.launch {
            launch::Launch::Vendored { .. } => format!(
                "[vncode] starting the harness on 127.0.0.1:{port} (vendored runtime, no npx)"
            ),
            launch::Launch::Npx => format!(
                "[vncode] starting the harness on 127.0.0.1:{port} (npx --yes @deepseek-ai/dsh@{} web --no-open)",
                self.version
            ),
            launch::Launch::Installed { bin, .. } => format!(
                "[vncode] starting the harness on 127.0.0.1:{port} (the installation this machine already has at {}, so no npm and no network)",
                bin.display()
            ),
            launch::Launch::Stub { .. } => format!(
                "[vncode] starting the STUB on 127.0.0.1:{port} (VNCODE_STUB_CLI is set - this is a check, not a harness)"
            ),
        }
    }
}

/// Decide everything Start needs, without spawning anything.
///
/// The ladders are resolved HERE, by writing where the harness will write, so the
/// panel can say "this home was refused, this one is in use" the moment it opens
/// rather than after a three-minute wait for a ready line that cannot arrive.
///
/// `remembered` is the home somebody chose in the panel (read from the app root by
/// the caller): it sits above the inherited `DSH_HOME` and below `-DshHome`.
pub fn plan(options: &Options, remembered: Option<&Path>) -> Result<Plan, String> {
    let root = launch::repo_root();
    let version = launch::resolve_version(options)?;
    // NOTHING OUTSIDE THIS APP'S OWN ROOT IS EVER THE HOME. The "installation already on
    // this machine" rung is gone: a folder that carries everything it needs must not
    // reach into a person's profile to start, and the two things that rung answered - a
    // home with no pack, and a home with no key - are answered by Start (which installs
    // the pack into the home in use) and by the key row. `~/.dsh` survives as the source
    // of the COPY offer alone, which only reads.
    let resolved = home::from_env(options.dsh_home.as_deref(), remembered);
    let chosen = launch::choose_launch(
        root.as_deref(),
        resolved.app_root_path(),
        resolved.home_path(),
        &version,
    );
    let mut notes = resolved.notes();
    // The preflight, as a NOTE here rather than a refusal: the panel says it the
    // moment it opens. Only an explicit `-DshHome` actually stops a Start (see
    // `Supervisor::start`).
    if let Some(problem) = resolved.problem() {
        notes.push(problem);
    }
    if let Some(note) = missing_pack_note(resolved.home_path(), launch::PROFILE) {
        notes.push(note);
    }
    if root.is_none() && matches!(chosen, launch::Launch::Npx) {
        notes.push(
            "no .dsh-version.json was found above this binary, so the pin came from -DshVersion"
                .to_string(),
        );
    }
    let (npm_cache, cache_note) = env::choose_cache(
        resolved.app_root_path(),
        resolved.home_path(),
        root.as_deref(),
    );
    if let Some(note) = cache_note {
        notes.push(note);
    }
    // ...and a temp directory the child can write in. The machine's is preferred and
    // left alone when it works; it is moved only for the measured case where a
    // confinement grants this app its own root and denies `%TEMP%` to the process
    // under it - which is how the harness's `dsh-spill-local` row failed to activate.
    let (temp, temp_note) = env::choose_temp(
        resolved.app_root_path(),
        vn_shell_core::appdata::machine_temp(),
        &mut vn_shell_core::appdata::probe,
    );
    if let Some(note) = temp_note {
        notes.push(note);
    }
    Ok(Plan {
        version,
        launch: chosen,
        home: resolved,
        npm_cache,
        temp,
        workspace: std::env::current_dir().ok(),
        root,
        port_hint: ports::choose_port(options),
        notes,
    })
}

/// A friendly nudge, never a refusal - the harness runs fine without the pack, so
/// a profile that never had it installed still starts, just unadorned. This is the
/// same warning `run-web.ps1` prints, from the same source of truth: the web
/// profile's own bundle list.
///
/// The words name the PANEL's own controls, which is where a reader of this note is
/// standing: **Start** installs the pack into THIS home before it starts the harness, and
/// **Install pack here** does the same on demand. Measured on a real run: the note said
/// "run scripts/setup/install.bat" to somebody looking at a window that has a button for
/// it, and the app went on looking broken.
///
/// NO MARKDOWN, and that is a rule rather than a preference: this string is drawn with
/// `ui.label`, so `**Install pack**` reaches the reader as literal asterisks - measured
/// on the first-run screen, beside the cards. Emphasis belongs in the docs, not in a
/// sentence a person reads in the window.
pub fn missing_pack_note(home: Option<&Path>, profile: &str) -> Option<String> {
    let home = home?;
    let profile_dir = home.join("profiles").join(profile);
    let manifest = profile_dir.join("package.json");
    if !manifest.is_file() {
        return Some(format!(
            "there is no {profile} profile at {} yet, so the harness will come up unadorned. Start installs this pack into THIS home first, or press Install pack here on the pack row",
            profile_dir.display()
        ));
    }
    let installed = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.get("dsh")?
                .get("profile")?
                .get("bundles")?
                .as_array()
                .map(|bundles| bundles.iter().any(|bundle| bundle.as_str() == Some("dsh-rightbar")))
        })
        .unwrap_or(false);
    if installed {
        None
    } else {
        Some(format!(
            "the {profile} profile at {} does not list this pack's bundles, so the harness comes up unadorned (no right bar, no editor, no themes). Start installs them into THIS home first (or press Install pack here on the pack row). To run the home that already has them instead, press Change and choose it",
            profile_dir.display()
        ))
    }
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------
/// The order the panel sends to the worker. There are only two.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Order {
    /// Take the tree down, check the port, and leave the app idle.
    Stop,
}

/// What Stop found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StopOutcome {
    /// Whether the port the harness held is free again. This is measured with a
    /// bind, never assumed from the kill's exit code.
    pub port_free: bool,
    /// The port that was checked, when there was one.
    pub port: Option<u16>,
}

impl StopOutcome {
    /// The line `check-shell.mjs` reads, and the one a reader wants.
    pub fn line(&self) -> String {
        match (self.port, self.port_free) {
            (Some(port), true) => format!("[vncode] stopped port={port} free=yes"),
            (Some(port), false) => format!("[vncode] stopped port={port} free=no"),
            (None, _) => "[vncode] stopped (nothing was running)".to_string(),
        }
    }
}

pub struct Supervisor {
    status: Mutex<Status>,
    /// The transcript the panel draws. Shared with the installer, so there is one
    /// log and one place that redacts.
    console: Arc<Console>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    orders: Mutex<Option<Sender<Order>>>,
    /// Read by the worker's loop and by `stop()`, so a second Stop is a no-op
    /// rather than a second kill aimed at a recycled pid.
    live: AtomicBool,
}

impl Supervisor {
    pub fn new(console: Arc<Console>) -> Self {
        Supervisor {
            status: Mutex::new(Status::idle()),
            console,
            worker: Mutex::new(None),
            orders: Mutex::new(None),
            live: AtomicBool::new(false),
        }
    }

    /// The panel's whole view of the instance.
    pub fn status(&self) -> Status {
        match self.status.lock() {
            Ok(status) => status.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn log_tail(&self, count: usize) -> Vec<String> {
        self.console.tail(count)
    }

    /// A cursor for [`Supervisor::log_since`]: the console's place in the log.
    pub fn log_position(&self) -> u64 {
        self.console.position()
    }

    /// Every line pushed since `position`, so a console can follow the log
    /// without printing a line twice or skipping one.
    pub fn log_since(&self, position: u64) -> Vec<String> {
        self.console.since(position)
    }

    pub fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    fn push_log(&self, line: &str) {
        self.console.push(line);
    }

    fn with_status(&self, change: impl FnOnce(&mut Status)) {
        match self.status.lock() {
            Ok(mut status) => change(&mut status),
            Err(poisoned) => change(&mut poisoned.into_inner()),
        }
    }

    fn fail(&self, message: impl Into<String>) {
        let message = message.into();
        self.with_status(|status| status.mark_failed(message.clone()));
        self.push_log(&format!("[vncode] {message}"));
        self.live.store(false, Ordering::SeqCst);
    }

    /// Start the pinned harness. Returns as soon as the worker is running; the
    /// panel follows the status from there.
    pub fn start(self: &Arc<Self>, options: Options, remembered: Option<PathBuf>) -> Result<(), String> {
        if self.is_live() {
            return Err("the harness is already running - press Stop first".to_string());
        }
        // The plan is resolved HERE, on the caller's thread, so a bad pin or an
        // unusable home is reported synchronously instead of appearing as a
        // failed thread a moment later.
        let plan = plan(&options, remembered.as_deref())?;
        // ...and a home that cannot be used is refused BEFORE anything is spawned.
        // Only an explicit `-DshHome` gets here: every other candidate falls through
        // the ladder to a home this app creates, which is the whole point of M0.
        if let Some(problem) = plan.home.problem() {
            return Err(problem);
        }
        let (orders, inbox) = mpsc::channel::<Order>();
        self.live.store(true, Ordering::SeqCst);
        {
            let mut slot = self.orders.lock().unwrap_or_else(|error| error.into_inner());
            *slot = Some(orders);
        }
        let shell = Arc::clone(self);
        let handle = thread::spawn(move || work(shell, options, plan, inbox));
        let mut slot = self.worker.lock().unwrap_or_else(|error| error.into_inner());
        *slot = Some(handle);
        Ok(())
    }

    /// Stop the tree, wait for it, and CHECK the port.
    ///
    /// Blocking on purpose: this is what makes "Stop" a claim with evidence
    /// behind it, and what lets `check-shell.mjs` assert the port is free the
    /// moment the process exits.
    pub fn stop(&self) -> StopOutcome {
        if let Some(orders) = self.orders.lock().unwrap_or_else(|error| error.into_inner()).take() {
            let _ = orders.send(Order::Stop);
        }
        if let Some(handle) =
            self.worker.lock().unwrap_or_else(|error| error.into_inner()).take()
        {
            let _ = handle.join();
        }
        let status = self.status();
        StopOutcome { port_free: status.port_free.unwrap_or(true), port: status.port }
    }
}

/// The worker: one child, one owner, one writer of the status.
fn work(shell: Arc<Supervisor>, options: Options, plan: Plan, inbox: mpsc::Receiver<Order>) {
    let Some(port) = ports::choose_port(&options) else {
        shell.fail("could not find a free loopback port to listen on");
        return;
    };
    shell.with_status(|status| {
        status.port = Some(port);
        status.phase = Phase::Starting;
        status.detail = Some(plan.runtime_line());
    });
    shell.push_log(&format!("[vncode] Pinned dsh version: {}", plan.version));
    let (path, why) = plan.home.row();
    shell.push_log(&format!("[vncode] DSH_HOME: {path} ({why})"));
    shell.push_log(&keystate::console_line(&keystate::read(plan.home_path())));
    for note in &plan.notes {
        shell.push_log(&format!("[vncode] note: {note}"));
    }

    let spec = launch::program_and_args(&plan.launch, &plan.version, port);
    let mut command = Command::new(&spec.program);
    command.args(&spec.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    // Its own process group, so Stop can signal the WHOLE tree - npx, the shell it
    // spawns and the node under both - with one call. Without this the POSIX half
    // has only the direct child, and killing that leaves a `node` holding the port.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // ...and, on Linux, the kernel's own answer to "the shell was killed outright":
    // the child dies with the parent thread that forked it, whatever the parent died
    // of. On macOS the process group above is the whole answer.
    arm_parent_death_signal(&mut command);

    // THE CHILD'S ENVIRONMENT IS COMPOSED, NEVER INHERITED. One composer builds it -
    // `DSH_HOME`, the npm cache, `PATH`, the working directory, and the console
    // markers removed - so a variable cannot be set for the harness and forgotten for
    // the installer. See `env`'s header for the measured bugs behind each row.
    let composed = env::for_plan(&plan);
    composed.apply(&mut command);
    shell.push_log(&format!("[vncode] child environment: {}", composed.line()));

    shell.push_log(&plan.start_line(port));

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            shell.fail(format!(
                "could not run {}: {error}. Install Node.js 22 or newer, or build the vendored runtime with scripts/tools/vendor.ps1.",
                spec.program.to_string_lossy()
            ));
            return;
        }
    };
    // Before anything else can go wrong: make the harness die with this shell.
    confine_to_job(&child);
    let pid = child.id();
    shell.with_status(|status| status.pid = Some(pid));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (ready_tx, ready_rx) = mpsc::channel::<Url>();
    if let Some(stdout) = stdout {
        drain(shell.clone(), stdout, Some(ready_tx));
    }
    if let Some(stderr) = stderr {
        drain(shell.clone(), stderr, None);
    }

    // The ready line - watched in short slices rather than in one 90-second
    // block, so that STOP CAN INTERRUPT A SLOW START. That is not a nicety: the
    // first run of an unvendored pin can spend a minute inside npx, and a Stop
    // button that does nothing for a minute is a button that lies. The same loop
    // is what lets a refusal (a ready line naming a foreign host) be followed by
    // an orderly stop instead of a 90-second wait.
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    let mut ready: Option<Url> = None;
    let mut stopped_while_starting = false;
    loop {
        match ready_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(url) => {
                ready = Some(url);
                break;
            }
            // Every sender is gone: the drain thread ends with the pipe, so this is
            // "the child stopped", not "it hung".
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                if matches!(inbox.try_recv(), Ok(Order::Stop) | Err(mpsc::TryRecvError::Disconnected))
                {
                    stopped_while_starting = true;
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
            }
        }
    }

    if stopped_while_starting {
        shell.with_status(|status| status.phase = Phase::Stopping);
        shell.push_log("[vncode] stopping the harness before it was ready");
        kill_tree(&mut child);
        let free = ports::port_is_free(port) && ports::port_is_unanswered(port);
        shell.with_status(|status| status.mark_stopped(free));
        shell.push_log(&shell.status().safe_line());
        shell.live.store(false, Ordering::SeqCst);
        return;
    }

    match ready {
        Some(url) => {
            shell.with_status(|status| status.mark_running(url.clone(), Some(pid)));
            shell.push_log("[vncode] the harness is ready; the launch token stays in memory");
            shell.push_log(&shell.status().safe_line());
        }
        None => {
            // Two ways to get here, and the child itself says which: it exited
            // before printing a ready line, or it is still running and the clock
            // ran out.
            let exited = child.try_wait().ok().flatten();
            kill_tree(&mut child);
            match exited {
                Some(exit) => shell.fail(format!(
                    "the harness stopped before it printed a ready line{}",
                    exit.code().map(|code| format!(" (exit code {code})")).unwrap_or_default()
                )),
                None => shell.fail(format!(
                    "the harness did not print its ready line within {} seconds. See the log.",
                    READY_TIMEOUT.as_secs()
                )),
            }
            return;
        }
    }

    // From here the worker is a loop with three ways out: an order, the child
    // dying on its own, or this process ending.
    let mut stopped_by_order = false;
    loop {
        match inbox.recv_timeout(POLL_INTERVAL) {
            Ok(Order::Stop) => {
                stopped_by_order = true;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            // The panel dropped the sender: treat it as an order to stop, which is
            // what closing the window means.
            Err(RecvTimeoutError::Disconnected) => {
                stopped_by_order = true;
                break;
            }
        }
        if let Ok(Some(exit)) = child.try_wait() {
            shell.push_log(&format!(
                "[vncode] the harness exited on its own{}",
                exit.code().map(|code| format!(" (exit code {code})")).unwrap_or_default()
            ));
            break;
        }
    }

    if stopped_by_order {
        shell.with_status(|status| status.phase = Phase::Stopping);
        shell.push_log("[vncode] stopping the harness");
    }
    kill_tree(&mut child);

    // The measurement, not the assumption: the port is asked whether it is free
    // again - and whether anything ANSWERS on it, which is the stronger question now
    // that the app takes a port of its own. A kill that returns success while a
    // grandchild survives is exactly the failure this catches.
    let free = ports::port_is_free(port) && ports::port_is_unanswered(port);
    shell.with_status(|status| status.mark_stopped(free));
    shell.push_log(&shell.status().safe_line());
    shell.live.store(false, Ordering::SeqCst);
}

/// Drain one of the child's streams: every line is redacted into the log, and the
/// first loopback ready URL is handed to the worker.
///
/// Both streams must keep being drained for as long as the harness runs - a pipe
/// nobody reads fills up and blocks the process writing to it.
fn drain<R: std::io::Read + Send + 'static>(
    shell: Arc<Supervisor>,
    reader: R,
    ready: Option<Sender<Url>>,
) {
    thread::spawn(move || {
        let mut reported = false;
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            shell.push_log(&line);
            if reported {
                continue;
            }
            let Some(sender) = ready.as_ref() else {
                continue;
            };
            let Some(candidate) = readyline::extract_ready_url(&line) else {
                continue;
            };
            match Url::parse(&candidate) {
                Ok(url) if url.host_str().map(readyline::is_loopback_host).unwrap_or(false) => {
                    if sender.send(url).is_ok() {
                        reported = true;
                    }
                }
                Ok(_) => {
                    shell.push_log(
                        "[vncode] the harness printed a URL that does not name a loopback address; it was NOT opened",
                    );
                }
                Err(error) => shell.push_log(&format!(
                    "[vncode] the harness printed a URL this shell could not parse: {error}"
                )),
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Taking the tree down
// ---------------------------------------------------------------------------
/// Stop the harness, and everything npx started underneath it.
///
/// `npx` is a launcher: the process this shell spawned is a shell script or a
/// `cmd.exe` wrapper whose child is the harness itself, so killing the direct child
/// alone would leave a `node` holding the port. Windows gets the whole tree from
/// `taskkill /T`; elsewhere the child was given its own process GROUP at spawn, so
/// one signal reaches every process in it.
pub fn kill_tree(child: &mut Child) {
    let pid = child.id();

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // SAFETY: `kill` is called with a negative pid, which is the documented
        // "signal this process group" form, and the group id is the child's own
        // pid because it was made a group leader at spawn (`process_group(0)`).
        // The return value is deliberately ignored: a group that is already gone
        // is the ordinary case here, not an error.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + STOP_GRACE;
        while std::time::Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// Put the harness in a Job Object that kills everything in it when this shell
/// dies - for ANY reason.
///
/// [`kill_tree`] handles the ordinary exit, but it only runs when the worker gets
/// to run: a crash, a `TerminateProcess` from Task Manager or a force-killed shell
/// never reaches it, and then `node` keeps the port. That is not a theory - it was
/// measured: force-killing the old shell left two `node` processes and a listening
/// port behind. A job object closes that hole, because the kernel does the killing
/// when the last handle to the job closes, and the last handle closes when this
/// process ends however it ends.
///
/// The job handle is deliberately LEAKED (never `CloseHandle`d): one handle for the
/// lifetime of the process is the entire point, and closing it early would kill the
/// harness we just started.
///
/// Children inherit job membership, so `cmd.exe`/`npx` and the `node` harness under
/// it are all covered.
#[cfg(target_os = "windows")]
fn confine_to_job(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: every call below is the documented Win32 sequence for a
    // kill-on-close job: create, set the limit, assign the child's own inherited
    // process handle. The struct is zero-initialised, which is what the API
    // expects (only LimitFlags is meaningful here); its size is taken from the
    // Rust type so it cannot drift from the C one; and the handle is left open on
    // purpose, with the process exit closing it.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[vncode] warning: could not create a job object - if this shell is killed outright, the harness may keep running.");
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            size,
        ) == 0
        {
            eprintln!("[vncode] warning: could not set kill-on-close on the job object - if this shell is killed outright, the harness may keep running.");
            return;
        }
        if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
            eprintln!("[vncode] warning: could not put the harness in the job object - if this shell is killed outright, the harness may keep running.");
        }
    }
}

/// On macOS/Linux the process group is the mechanism (see [`kill_tree`]): the child
/// is a group leader, so one `kill(-pgid, …)` reaches everything it started. A kill
/// of the SHELL itself still leaks the tree there, which is the hole the Windows job
/// object closes.
///
/// Linux answers it in the kernel: `PR_SET_PDEATHSIG` asks for a signal when the
/// parent THREAD that forked dies, which is what happens when this process is killed
/// however it is killed. The signal is set in the child between `fork` and `exec`, so
/// it is inherited by nothing and cannot be observed by a program that has not
/// started yet. macOS has no equivalent (`procctl`/`kqueue` need a kevent loop this
/// supervisor does not have), so there the process group plus `kill_tree` is the
/// whole answer, and a force-kill of the shell can leak - recorded as a known limit
/// rather than papered over.
#[cfg(target_os = "linux")]
fn arm_parent_death_signal(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the child after `fork` and before `exec`, so it may
    // only call async-signal-safe functions. `prctl` is a raw syscall wrapper with no
    // allocation, no lock and no Rust runtime behind it; the return value is ignored
    // because a kernel that refuses the request leaves the process-group cleanup as
    // the fallback, which is the behaviour that already existed.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
}

/// Nothing to arm where the kernel has no such request.
#[cfg(not(target_os = "linux"))]
fn arm_parent_death_signal(_command: &mut Command) {}

/// On macOS/Linux the process group is the mechanism (see [`kill_tree`]).
#[cfg(not(target_os = "windows"))]
fn confine_to_job(_child: &Child) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_stop_line_is_what_a_check_reads() {
        let outcome = StopOutcome { port_free: true, port: Some(3080) };
        assert_eq!(outcome.line(), "[vncode] stopped port=3080 free=yes");
        let leaked = StopOutcome { port_free: false, port: Some(3080) };
        assert_eq!(leaked.line(), "[vncode] stopped port=3080 free=no");
        let idle = StopOutcome { port_free: true, port: None };
        assert_eq!(idle.line(), "[vncode] stopped (nothing was running)");
    }

    #[test]
    fn a_fresh_supervisor_is_idle_and_has_never_spawned_anything() {
        let shell = Supervisor::new(Arc::new(Console::new()));
        assert!(!shell.is_live());
        assert_eq!(shell.status().phase, Phase::Idle);
        assert!(shell.log_tail(10).is_empty());
    }

    #[test]
    fn stopping_something_that_never_started_is_not_a_failure() {
        // The panel calls Stop in the idle state, and on the way out. It must not
        // report a phantom leak.
        let shell = Supervisor::new(Arc::new(Console::new()));
        let outcome = shell.stop();
        assert!(outcome.port_free);
        assert_eq!(outcome.port, None);
    }

    #[test]
    fn the_plan_names_what_will_run_rather_than_what_was_hoped_for() {
        // -DshVersion makes the plan resolvable with no checkout at a known path,
        // which is what lets this test run from anywhere.
        let options = Options { dsh_version: Some("9.9.9".into()), ..Options::default() };
        let plan = plan(&options, None).expect("the plan must resolve with an explicit pin");
        assert_eq!(plan.version, "9.9.9");
        let line = plan.runtime_line();
        assert!(
            line.contains("vendored") || line.contains("npx") || line.contains("TEST SEAM"),
            "{line}"
        );
        // The start line names the port it will really use.
        let start = plan.start_line(3080);
        assert!(start.contains("127.0.0.1:3080"), "{start}");
        // ...and never the launch token, which does not exist yet at this point.
        assert!(!start.contains("token="), "{start}");
    }

    #[test]
    fn an_explicit_dshhome_that_cannot_be_written_refuses_and_names_the_flag() {
        // The failure this pins, measured on a machine whose app was started from
        // inside a program that confines its children: the harness died on
        // `EPERM ... .dsh\profiles\web\cordis.yml` three minutes after Start, and the
        // app could have known instantly. What changed in M0 is WHICH answer that is:
        // an inherited or default home now falls through to one this app creates, and
        // only a `-DshHome` the person typed is a refusal.
        let root = scratch_dir("home-problem");
        std::fs::create_dir_all(&root).unwrap();
        // A home whose parent is a FILE can never be created on any platform.
        let blocker = root.join("blocker");
        std::fs::write(&blocker, b"a file, not a directory").unwrap();
        let impossible = blocker.join(".dsh");

        let shell = Arc::new(Supervisor::new(Arc::new(Console::new())));
        let options = Options {
            dsh_home: Some(impossible.display().to_string()),
            dsh_version: Some("9.9.9".into()),
            ..Options::default()
        };
        let error = shell
            .start(options, None)
            .expect_err("an impossible -DshHome must refuse");
        assert!(error.contains("-DshHome names"), "{error}");
        assert!(error.contains("blocker"), "{error}");
        // ...and nothing was spawned by the refusal.
        assert!(!shell.is_live());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_plan_always_names_a_home_and_an_app_root() {
        // The ordinary case after M0: a home this app can write is always found, so
        // "the plan exists" and "there is a harness home" are the same statement.
        let options = Options { dsh_version: Some("9.9.9".into()), ..Options::default() };
        let plan = plan(&options, None).expect("the plan must resolve with an explicit pin");
        let home = plan.home_path().expect("a home is always decided");
        let root = plan.app_root().expect("a root is always decided");
        // The home is EITHER an inherited `DSH_HOME` that was writable (the app joins
        // the session that started it) OR the default inside the app's own root. Both
        // are correct; what must never happen is a home that is neither.
        let origin = plan.home.home.as_ref().unwrap().origin;
        match origin {
            vn_shell_core::home::Origin::Inherited | vn_shell_core::home::Origin::Flag => {}
            _ => assert_eq!(home.parent(), Some(root), "the default home must sit in the root"),
        }
        // The composed environment names the home, and never the app's own word for
        // its root - the harness knows `DSH_HOME` and nothing else.
        let line = plan.env_line();
        assert!(line.contains("DSH_HOME="), "{line}");
        assert!(line.contains(&home.display().to_string()), "{line}");
        assert!(!line.contains("VNCODE_HOME="), "{line}");
    }

    #[test]
    fn a_missing_profile_is_a_note_and_never_a_refusal() {
        let root = scratch_dir("missing-pack");
        std::fs::create_dir_all(root.join("profiles").join("web")).unwrap();
        let note = missing_pack_note(Some(&root), "web").expect("a note is due");
        assert!(note.contains("no web profile"), "{note}");
        // The words point at the PANEL's own controls, which is where the reader is -
        // not at an installer script they would have to run by hand, and not at a button
        // this build no longer has.
        assert!(note.contains("Start installs"), "{note}");
        assert!(note.contains("Install pack here"), "{note}");
        // A profile with the manifest but without the pack gets the other note.
        std::fs::write(
            root.join("profiles").join("web").join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#,
        )
        .unwrap();
        let note = missing_pack_note(Some(&root), "web").expect("a note is due");
        assert!(note.contains("does not list this pack's bundles"), "{note}");
        assert!(note.contains("unadorned"), "{note}");
        assert!(note.contains("press Change and choose it"), "{note}");
        // MARKDOWN IS NOT RENDERED HERE. This sentence is drawn with `ui.label`, so
        // `**bold**` reaches the reader as asterisks - measured on the first-run screen,
        // where the note sat beside the cards. No emphasis, anywhere in a note.
        for note in [
            missing_pack_note(Some(&root), "web").unwrap(),
            missing_pack_note(Some(&root.join("nothing")), "web").unwrap(),
        ] {
            assert!(!note.contains("**"), "a note carries markdown emphasis: {note}");
        }
        // ...and one that lists the pack gets nothing at all.
        std::fs::write(
            root.join("profiles").join("web").join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["dsh-rightbar"]}}}"#,
        )
        .unwrap();
        assert_eq!(missing_pack_note(Some(&root), "web"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A scratch directory for THIS crate's tests: `vn-shell-core`'s helper is
    /// test-only and private to it, and a check may point both at one root.
    fn scratch_dir(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-runtime-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }
}
