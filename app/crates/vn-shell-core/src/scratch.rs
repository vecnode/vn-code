//! Where a test writes when it needs a real file.
//!
//! `std::env::temp_dir()` is the default and the right answer on an ordinary
//! machine. It is not the right answer on a locked-down one: a sandbox that
//! denies `%TEMP%` (this repository's own checks are run inside one) turns every
//! test that touches a file into a failure about the HOST rather than about the
//! code, and a check that cannot run says nothing about the change under test.
//!
//! So the root is overridable: `VNCODE_TEST_DIR` is read first, and
//! `scripts/checks/check-shell.mjs` points it at a folder inside the checkout
//! before it runs `cargo test`. Nothing outside a test reads this.

use std::path::PathBuf;

/// The directory a test may create things in.
pub fn root() -> PathBuf {
    match std::env::var_os("VNCODE_TEST_DIR") {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => std::env::temp_dir(),
    }
}

/// A fresh, empty, per-process directory under [`root`].
pub fn dir(name: &str) -> PathBuf {
    let path = root().join(format!("vncode-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}
