//! The shell's log: bounded, and redacted on the way in.
//!
//! Two rules, both from things that went wrong elsewhere in this pack:
//!
//! - a transcript that grows without a ceiling is a memory leak with a friendly
//!   name, so this one is a ring with a cap and the oldest line leaves first;
//! - the harness's own output passes through [`crate::readyline::redact`] BEFORE
//!   it is stored, so a line that carried the launch token cannot be sitting in
//!   the panel when somebody screenshots it. Redacting at push rather than at
//!   draw means there is no code path that can skip it.

use std::collections::VecDeque;

use crate::readyline::redact;

/// How many lines the panel keeps. Enough for a start-up transcript, small enough
/// that the ring can never be the reason the app grows.
pub const DEFAULT_CAP: usize = 500;

pub struct Log {
    lines: VecDeque<String>,
    cap: usize,
    /// How many lines have EVER been pushed, so a reader can follow the log
    /// without losing its place when the ring drops the oldest line.
    pushed: u64,
}

impl Default for Log {
    fn default() -> Self {
        Log::new(DEFAULT_CAP)
    }
}

impl Log {
    /// A cap of zero is a log that keeps nothing, which is legal but pointless -
    /// it is clamped to one line so the type cannot be used as a silent discard.
    pub fn new(cap: usize) -> Self {
        Log { lines: VecDeque::new(), cap: cap.max(1), pushed: 0 }
    }

    /// Store one line, redacted. The ONLY way in.
    pub fn push(&mut self, line: &str) {
        while self.lines.len() >= self.cap {
            self.lines.pop_front();
        }
        self.lines.push_back(redact(line));
        self.pushed += 1;
    }

    /// A cursor for [`Log::since`]: hand this back later to get only what is new.
    pub fn position(&self) -> u64 {
        self.pushed
    }

    /// Every line pushed at or after `position`, oldest first.
    ///
    /// A `position` that is older than the ring's own memory simply starts at the
    /// oldest line still held: a reader that fell behind gets what is left rather
    /// than an error, which is the right trade for a transcript.
    pub fn since(&self, position: u64) -> Vec<String> {
        let oldest = self.pushed.saturating_sub(self.lines.len() as u64);
        let skip = position.saturating_sub(oldest) as usize;
        self.lines.iter().skip(skip).cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn cap(&self) -> usize {
        self.cap
    }

    pub fn lines(&self) -> impl Iterator<Item = &str> {
        self.lines.iter().map(String::as_str)
    }

    /// The newest `count` lines, oldest first - the order a person reads them.
    pub fn tail(&self, count: usize) -> Vec<String> {
        let skip = self.lines.len().saturating_sub(count);
        self.lines.iter().skip(skip).cloned().collect()
    }

    /// Everything, for the console or for a bug report.
    pub fn joined(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String {
        format!("{}{}", "cafebabe", "1122334455667788")
    }

    #[test]
    fn a_line_that_carried_the_token_is_stored_redacted() {
        let mut log = Log::default();
        log.push(&format!("dsh web: http://127.0.0.1:3080/?token={}", token()));
        let stored = log.joined();
        assert!(!stored.contains(&token()), "the token reached the log: {stored}");
        assert!(stored.contains("REDACTED"), "{stored}");
        // ...and it is still readable enough to be useful.
        assert!(stored.contains("127.0.0.1:3080"), "{stored}");
    }

    #[test]
    fn the_ring_drops_the_oldest_line_first() {
        let mut log = Log::new(3);
        for line in ["one", "two", "three", "four"] {
            log.push(line);
        }
        assert_eq!(log.len(), 3);
        assert_eq!(log.tail(10), vec!["two", "three", "four"]);
    }

    #[test]
    fn a_zero_cap_is_clamped_rather_than_silently_discarding_everything() {
        let mut log = Log::new(0);
        log.push("kept");
        assert_eq!(log.len(), 1);
        assert_eq!(log.cap(), 1);
    }

    #[test]
    fn the_tail_is_the_newest_lines_in_reading_order() {
        let mut log = Log::default();
        for index in 0..10 {
            log.push(&format!("line {index}"));
        }
        assert_eq!(log.tail(2), vec!["line 8", "line 9"]);
        assert_eq!(log.tail(0).len(), 0);
        assert_eq!(log.tail(999).len(), 10);
    }

    #[test]
    fn a_reader_can_follow_the_log_without_losing_its_place() {
        // This is what the headless mode and the panel's console use: a cursor
        // rather than a tail, so a line cannot be printed twice or skipped.
        let mut log = Log::default();
        log.push("one");
        let cursor = log.position();
        log.push("two");
        log.push("three");
        assert_eq!(log.since(cursor), vec!["two", "three"]);
        // Reading again from the same cursor is idempotent...
        assert_eq!(log.since(cursor), vec!["two", "three"]);
        // ...and a cursor at the end yields nothing.
        assert!(log.since(log.position()).is_empty());
    }

    #[test]
    fn a_reader_that_fell_behind_gets_what_is_left_rather_than_an_error() {
        let mut log = Log::new(2);
        for index in 0..6 {
            log.push(&format!("line {index}"));
        }
        // The ring holds line 4 and line 5; a cursor from the very beginning
        // therefore starts at line 4.
        assert_eq!(log.since(0), vec!["line 4", "line 5"]);
        assert_eq!(log.since(5), vec!["line 5"]);
        assert!(log.since(6).is_empty());
        assert_eq!(log.position(), 6);
    }
}
