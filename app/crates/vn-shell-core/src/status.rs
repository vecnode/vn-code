//! What the panel draws, and the one field in it that must never be printed.
//!
//! The harness prints its ready line with the launch token in it, and the shell
//! hands that URL to the pane. So the live URL has to be held somewhere - and
//! everything about this module exists to make holding it safe:
//!
//! - it is PRIVATE, reachable only through [`Status::navigate_url`], whose doc
//!   says out loud that it is for the pane and nothing else;
//! - [`Status::public_url`] is the displayable form, with the query (and with it
//!   the token) stripped;
//! - [`Status`]'s `Debug` is written BY HAND, because a derived one would print
//!   the token into a panic message, a log line or a test failure - which is
//!   exactly the accident the launch-token rules exist to prevent;
//! - [`Status::safe_line`], which is what the console prints, is built from the
//!   safe parts alone.

use std::fmt;
use std::time::{Duration, Instant};

use url::Url;

/// Where the instance is in its life. Nothing here is a guess: `Running` is set
/// from the ready line, and `Stopped` only after the tree is dead and the port has
/// been checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// The app just opened. Nothing has been started, and nothing will be until
    /// Start is pressed.
    Idle,
    /// A child exists and its ready line has not arrived yet.
    Starting,
    /// The ready line arrived; the URL is known.
    Running,
    /// Stop was pressed and the tree is being taken down.
    Stopping,
    /// Stopped, with the port checked.
    Stopped,
    /// Something went wrong. `detail` says what, in words safe to paste.
    Failed,
}

impl Phase {
    pub fn label(self) -> &'static str {
        match self {
            Phase::Idle => "stopped",
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Stopping => "stopping",
            Phase::Stopped => "stopped",
            Phase::Failed => "failed",
        }
    }

    /// Whether a child process exists in this phase.
    pub fn is_live(self) -> bool {
        matches!(self, Phase::Starting | Phase::Running | Phase::Stopping)
    }
}

/// The status the panel renders, shared between the supervisor thread and the UI.
///
/// `Clone` is what lets the panel take a snapshot each frame instead of holding
/// the lock while it draws. Cloning the URL clones the token with it, which is
/// fine - it stays in memory either way, and `Debug` is still hand-written.
#[derive(Clone)]
pub struct Status {
    pub phase: Phase,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    /// The loopback URL, WITH the launch token. Private on purpose - see the
    /// module header.
    url: Option<Url>,
    /// A message that is safe to show and to paste: it never contains the token.
    pub detail: Option<String>,
    /// The result of the post-Stop port check. `None` means "not checked".
    pub port_free: Option<bool>,
    started: Option<Instant>,
}

impl Default for Status {
    fn default() -> Self {
        Status {
            phase: Phase::Idle,
            port: None,
            pid: None,
            url: None,
            detail: None,
            port_free: None,
            started: None,
        }
    }
}

impl Status {
    pub fn idle() -> Status {
        Status::default()
    }

    pub fn set_url(&mut self, url: Url) {
        self.url = Some(url);
    }

    /// The full URL, token included: for handing to the pane, and for nothing
    /// else. Every other reader wants [`Status::public_url`].
    pub fn navigate_url(&self) -> Option<&str> {
        self.url.as_ref().map(Url::as_str)
    }

    /// The displayable URL: scheme, host and port, with the query dropped.
    pub fn public_url(&self) -> Option<String> {
        let url = self.url.as_ref()?;
        let host = url.host_str()?;
        let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
        Some(format!("{}://{host}{port}/", url.scheme()))
    }

    pub fn uptime(&self) -> Option<Duration> {
        self.started.map(|started| started.elapsed())
    }

    /// How long it has been up, in words: `3s`, `1m 04s`, `2h 07m`.
    pub fn uptime_label(&self) -> Option<String> {
        let seconds = self.uptime()?.as_secs();
        Some(match seconds {
            0..=59 => format!("{seconds}s"),
            60..=3599 => format!("{}m {:02}s", seconds / 60, seconds % 60),
            _ => format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60),
        })
    }

    /// One line for the console and the log: the safe parts only.
    pub fn safe_line(&self) -> String {
        match self.phase {
            Phase::Idle => "[vncode] idle - nothing is running".to_string(),
            Phase::Starting => format!(
                "[vncode] starting the {} harness on 127.0.0.1:{}",
                self.detail.as_deref().unwrap_or("pinned"),
                self.port.map(|port| port.to_string()).unwrap_or_else(|| "?".to_string())
            ),
            Phase::Running => format!(
                "[vncode] running on {} (pid {})",
                self.public_url().unwrap_or_else(|| "?".to_string()),
                self.pid.map(|pid| pid.to_string()).unwrap_or_else(|| "?".to_string())
            ),
            Phase::Stopping => "[vncode] stopping the harness".to_string(),
            Phase::Stopped => match self.port_free {
                Some(true) => "[vncode] stopped; the port is free again".to_string(),
                Some(false) => {
                    "[vncode] stopped, but something STILL holds the port - see the log".to_string()
                }
                None => "[vncode] stopped".to_string(),
            },
            Phase::Failed => format!(
                "[vncode] failed: {}",
                self.detail.as_deref().unwrap_or("no reason recorded")
            ),
        }
    }

    /// Move into `Running`, which is also where the clock starts.
    pub fn mark_running(&mut self, url: Url, pid: Option<u32>) {
        self.url = Some(url);
        self.pid = pid;
        self.phase = Phase::Running;
        self.started = Some(Instant::now());
        self.port_free = None;
    }

    /// Move into `Stopped`, recording what the port check found.
    pub fn mark_stopped(&mut self, port_free: bool) {
        self.phase = Phase::Stopped;
        self.pid = None;
        self.url = None;
        self.started = None;
        self.port_free = Some(port_free);
    }

    pub fn mark_failed(&mut self, detail: impl Into<String>) {
        self.phase = Phase::Failed;
        self.detail = Some(detail.into());
        self.pid = None;
        self.url = None;
        self.started = None;
    }
}

impl fmt::Debug for Status {
    /// Hand-written, and the reason is in the module header: a derived `Debug`
    /// would print the launch token.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Status")
            .field("phase", &self.phase)
            .field("port", &self.port)
            .field("pid", &self.pid)
            .field("url", &self.public_url().map(|_| "<redacted>"))
            .field("detail", &self.detail)
            .field("port_free", &self.port_free)
            .field("uptime", &self.uptime_label())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assembled at runtime so no token-shaped literal exists in this repository.
    fn token() -> String {
        format!("{}{}", "deadbeef", "0123456789abcdef")
    }

    fn running() -> Status {
        let url = Url::parse(&format!("http://127.0.0.1:3080/?token={}", token())).unwrap();
        let mut status = Status::idle();
        status.port = Some(3080);
        status.mark_running(url, Some(4321));
        status
    }

    #[test]
    fn the_displayed_url_never_carries_the_launch_token() {
        let status = running();
        let public = status.public_url().unwrap();
        assert_eq!(public, "http://127.0.0.1:3080/");
        assert!(!public.contains(&token()));
        assert!(!public.contains("token"));
    }

    #[test]
    fn the_full_url_is_reachable_only_through_the_navigator_accessor() {
        let status = running();
        // The pane needs it, token and all: that is ONE documented reader.
        assert!(status.navigate_url().unwrap().contains(&token()));
        // ...and the two things a person can see never show it.
        assert!(!status.safe_line().contains(&token()));
        assert!(!format!("{status:?}").contains(&token()));
        assert!(!status.safe_line().contains("token="));
    }

    #[test]
    fn the_console_line_names_the_safe_url_and_the_pid() {
        let line = running().safe_line();
        assert!(line.contains("http://127.0.0.1:3080/"), "{line}");
        assert!(line.contains("4321"), "{line}");
    }

    #[test]
    fn stopping_clears_the_url_so_a_dead_instance_cannot_be_reopened() {
        let mut status = running();
        status.mark_stopped(true);
        assert_eq!(status.phase, Phase::Stopped);
        assert_eq!(status.navigate_url(), None);
        assert_eq!(status.public_url(), None);
        assert!(status.safe_line().contains("the port is free again"), "{}", status.safe_line());
    }

    #[test]
    fn a_port_something_still_holds_is_reported_rather_than_hidden() {
        let mut status = running();
        status.mark_stopped(false);
        assert_eq!(status.port_free, Some(false));
        assert!(status.safe_line().contains("STILL holds the port"), "{}", status.safe_line());
    }

    #[test]
    fn a_failure_says_what_failed_and_forgets_the_url() {
        let mut status = running();
        status.mark_failed("the harness did not print its ready line within 90 seconds");
        assert_eq!(status.phase, Phase::Failed);
        assert_eq!(status.navigate_url(), None);
        assert!(status.safe_line().contains("90 seconds"), "{}", status.safe_line());
    }

    #[test]
    fn uptime_is_reported_in_words() {
        let mut status = running();
        assert!(status.uptime_label().is_some());
        status.started = Some(Instant::now() - Duration::from_secs(64));
        assert_eq!(status.uptime_label().as_deref(), Some("1m 04s"));
        status.started = Some(Instant::now() - Duration::from_secs(7800));
        assert_eq!(status.uptime_label().as_deref(), Some("2h 10m"));
        status.mark_stopped(true);
        assert_eq!(status.uptime_label(), None, "a stopped instance has no uptime");
    }

    #[test]
    fn only_the_live_phases_are_live() {
        assert!(Phase::Starting.is_live());
        assert!(Phase::Running.is_live());
        assert!(Phase::Stopping.is_live());
        assert!(!Phase::Idle.is_live());
        assert!(!Phase::Stopped.is_live());
        assert!(!Phase::Failed.is_live());
    }
}
