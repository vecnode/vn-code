//! The one transcript.
//!
//! The supervisor writes the harness's output into it and the installer writes
//! its own output into it, so the panel has ONE log rather than two, and
//! redaction happens in exactly one place - on the way in, inside
//! `vn_shell_core::log::Log::push`. A second log would be a second chance to
//! forget that rule.

use std::sync::Mutex;

use vn_shell_core::log::Log;

#[derive(Default)]
pub struct Console {
    log: Mutex<Log>,
}

impl Console {
    pub fn new() -> Self {
        Console::default()
    }

    /// Store one line. The only way in, and it redacts.
    pub fn push(&self, line: &str) {
        match self.log.lock() {
            Ok(mut log) => log.push(line),
            Err(poisoned) => poisoned.into_inner().push(line),
        }
    }

    /// A cursor, for a reader that must not repeat or skip a line.
    pub fn position(&self) -> u64 {
        match self.log.lock() {
            Ok(log) => log.position(),
            Err(poisoned) => poisoned.into_inner().position(),
        }
    }

    pub fn since(&self, position: u64) -> Vec<String> {
        match self.log.lock() {
            Ok(log) => log.since(position),
            Err(poisoned) => poisoned.into_inner().since(position),
        }
    }

    pub fn tail(&self, count: usize) -> Vec<String> {
        match self.log.lock() {
            Ok(log) => log.tail(count),
            Err(poisoned) => poisoned.into_inner().tail(count),
        }
    }

    pub fn len(&self) -> usize {
        match self.log.lock() {
            Ok(log) => log.len(),
            Err(poisoned) => poisoned.into_inner().len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String {
        format!("{}{}", "feedface", "0011223344556677")
    }

    #[test]
    fn a_line_that_carried_the_token_is_stored_redacted() {
        // The installer prints paths, and a path can carry a token only if
        // something upstream did; this pins that the console is not the place it
        // escapes from, whichever writer it came through.
        let console = Console::new();
        console.push(&format!("dsh web: http://127.0.0.1:3080/?token={}", token()));
        let stored = console.tail(10).join("\n");
        assert!(!stored.contains(&token()), "the token reached the console: {stored}");
        assert!(stored.contains("REDACTED"), "{stored}");
    }

    #[test]
    fn two_writers_share_one_cursor() {
        // The supervisor and the installer write here; a reader following the
        // cursor sees each line once, in the order it was written.
        let console = Console::new();
        let start = console.position();
        console.push("[vncode] from the supervisor");
        console.push("[vncode] from the installer");
        assert_eq!(
            console.since(start),
            vec!["[vncode] from the supervisor", "[vncode] from the installer"]
        );
        assert!(console.since(console.position()).is_empty());
    }
}
