//! The vncode shell's PURE half.
//!
//! Everything here is decided by `cargo test` and nothing here opens a window,
//! draws a pixel or owns a process. The split is the shell's whole safety
//! argument: the rules that keep the launch token and the model API key inside
//! (`readyline`, `keystate`) and the rules that decide WHICH harness this shell
//! shows (`home`, `launch`, `ports`) are testable without a display, without a
//! network and without a harness on disk.
//!
//! The four modules that carry the load-bearing rules were MOVED here from the
//! old `app/src-tauri` tree rather than rewritten, comments and tests included:
//! `readyline`, `windowstate`, `keystate` and — as what is now `appdata` — the
//! application-data root. A rewrite of any of them would be a regression by
//! definition, because each one is the record of a bug that was measured on a real
//! machine. (`payload`, the single-file container reader, was the fourth and left
//! with the distributer that produced such files; `appdata` is the part of it that
//! was still load-bearing.)

pub mod adopt;
pub mod appdata;
pub mod appprefs;
pub mod browser;
pub mod firstrun;
pub mod home;
pub mod keystate;
pub mod launch;
pub mod log;
pub mod options;
pub mod ports;
pub mod prefs;
pub mod profile;
pub mod readyline;
pub mod status;
pub mod urlpolicy;
pub mod userpath;
pub mod windowstate;

/// Where a test writes. Test-only, and overridable so the checks can run on a
/// host that denies the system temp directory.
#[cfg(test)]
mod scratch;
