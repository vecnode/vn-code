//! The vncode shell's PURE half.
//!
//! Everything here is decided by `cargo test`, and nothing here opens a window, draws a
//! pixel, binds a port or owns a process. The split is the shell's whole safety argument:
//! the rules that keep the model API key inside (`keystate`) and the rules that decide
//! WHICH harness home this shell runs against (`home`, `appdata`, `userpath`) are testable
//! without a display, without a network and without a harness on disk.
//!
//! There is no web engine here and no window state. The page is the harness's, it is
//! served on loopback, and the browser that shows it is started by `scripts/run-web.*` -
//! which is also the only thing that ever reads a launch token.
//!
//! The modules that carry the load-bearing rules were MOVED here from the old
//! `app/src-tauri` tree rather than rewritten, comments and tests included: `readyline`
//! (the token, and its redaction), `keystate` (the four key layers, presence only) and -
//! as what is now `appdata` - the application-data root. A rewrite of any of them would be
//! a regression by definition, because each one is the record of a bug that was measured
//! on a real machine.

pub mod appdata;
pub mod home;
pub mod keystate;
pub mod launch;
pub mod log;
pub mod options;
pub mod ports;
pub mod prefs;
pub mod profile;
pub mod readyline;
pub mod userpath;

/// Where a test writes. Test-only, and overridable so the checks can run on a
/// host that denies the system temp directory.
#[cfg(test)]
mod scratch;
