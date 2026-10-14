//! Adopt, run: copy the durable small things out of a home this app did not create.
//!
//! The DECISION - what may be copied, and whether to offer it at all - is pure and
//! lives in `vn_shell_core::adopt`, with its own tests. This module is the part that
//! touches the filesystem and the console: a bounded recursive copy, one line per
//! tree, and the credentials file behind its own call.
//!
//! Three rules travel with it:
//!
//! 1. **Nothing is written into the source.** Only the target is created.
//! 2. **A file that already exists is never overwritten.** Adopt runs against the
//!    app's untouched home by construction (`adopt::target_is_untouched`), so a
//!    collision means somebody got there first - and the right answer to that is to
//!    skip it and say so, not to merge two installations.
//! 3. **A symlink is skipped, not followed.** A junction inside `skills/` could point
//!    anywhere, and a copy that follows one has left the home it was asked to read.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use vn_shell_core::adopt::{self, Adoption};

use crate::console::Console;

/// What an Adopt run is doing, in words the panel may draw.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AdoptState {
    pub running: bool,
    /// The trees that were copied, in the order they were planned.
    pub copied: Vec<String>,
    /// How many files were copied.
    pub files: usize,
    /// How many files were left alone because the target already had them.
    pub skipped: usize,
    /// How many links were skipped rather than followed.
    pub links: usize,
    pub bytes: u64,
    /// The first thing that went wrong, if anything did.
    pub failed: Option<String>,
    /// Whether this run took the credentials file with it.
    pub with_credentials: bool,
}

impl AdoptState {
    pub fn line(&self) -> String {
        match (&self.failed, self.running, self.copied.is_empty()) {
            (Some(error), _, _) => format!("[vncode] adopt FAILED: {error}"),
            (None, true, _) => "[vncode] adopting...".to_string(),
            (None, false, true) => "[vncode] nothing was adopted".to_string(),
            (None, false, false) => format!(
                "[vncode] adopted {} ({} file(s){}, {}{}{})",
                self.copied.join(", "),
                self.files,
                if self.skipped > 0 {
                    format!(", {} left alone", self.skipped)
                } else {
                    String::new()
                },
                human(self.bytes),
                if self.with_credentials { ", credentials file included" } else { "" },
                if self.links > 0 { ", links skipped" } else { "" }
            ),
        }
    }
}

/// A small human size, so the log line reads like a person wrote it.
fn human(bytes: u64) -> String {
    const UNITS: [(&str, u64); 3] = [("GiB", 1 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)];
    for (unit, scale) in UNITS {
        if bytes >= scale {
            return format!("{:.1} {unit}", bytes as f64 / scale as f64);
        }
    }
    format!("{bytes} B")
}

/// The runner: one run at a time, one writer of the state, on its own thread.
pub struct Adopt {
    console: Arc<Console>,
    state: Mutex<AdoptState>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    running: AtomicBool,
}

impl Adopt {
    pub fn new(console: Arc<Console>) -> Self {
        Adopt {
            console,
            state: Mutex::new(AdoptState::default()),
            worker: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }

    pub fn state(&self) -> AdoptState {
        match self.state.lock() {
            Ok(state) => state.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Copy the planned trees, optionally taking the credential document too.
    pub fn start(self: &Arc<Self>, adoption: Adoption, with_credentials: bool) -> Result<(), String> {
        if self.is_running() {
            return Err("an adopt run is already in flight".to_string());
        }
        if adoption.items.is_empty() && !with_credentials {
            return Err("there is nothing to adopt from that home".to_string());
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            *state = AdoptState { running: true, with_credentials, ..AdoptState::default() };
        }
        self.running.store(true, Ordering::SeqCst);
        let shell = Arc::clone(self);
        let handle = thread::spawn(move || run(shell, adoption, with_credentials));
        let mut slot = self.worker.lock().unwrap_or_else(|error| error.into_inner());
        *slot = Some(handle);
        Ok(())
    }

    /// Wait for a run in flight. The panel never calls this; a check does.
    pub fn join(&self) {
        let handle = self.worker.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    fn finish(&self, change: impl FnOnce(&mut AdoptState)) {
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.running = false;
            change(&mut state);
        }
        self.running.store(false, Ordering::SeqCst);
        self.console.push(&self.state().line());
    }
}

fn run(shell: Arc<Adopt>, adoption: Adoption, with_credentials: bool) {
    shell.console.push(&format!("[vncode] {}", adoption.line()));
    let mut copied = Vec::new();
    let mut files = 0usize;
    let mut skipped = 0usize;
    let mut links = 0usize;
    let mut bytes = 0u64;

    for item in &adoption.items {
        match copy_tree(&item.from, &item.to) {
            Ok(report) => {
                files += report.files;
                skipped += report.skipped;
                links += report.links;
                bytes += report.bytes;
                copied.push(item.name.to_string());
                shell.console.push(&format!(
                    "[vncode] adopted {} ({} file(s), {})",
                    item.name,
                    report.files,
                    human(report.bytes)
                ));
            }
            Err(error) => {
                shell.finish(|state| {
                    state.copied = copied;
                    state.files = files;
                    state.skipped = skipped;
                    state.links = links;
                    state.bytes = bytes;
                    state.with_credentials = with_credentials;
                    state.failed = Some(error);
                });
                return;
            }
        }
    }

    // The credentials file, when the person asked for it. A byte copy: the value is
    // never parsed, never held, never drawn - which is what keeps `SECURITY.md`'s
    // "presence only" promise true.
    if with_credentials {
        if let Some(from) = adoption.credential() {
            let to = adoption.target.join(adopt::CREDENTIALS);
            match copy_file(&from, &to) {
                Ok(Some(written)) => {
                    bytes += written;
                    shell.console.push(
                        "[vncode] the credentials file was copied - the key itself was never read",
                    );
                }
                Ok(None) => shell.console.push(
                    "[vncode] the credentials file was left alone: the chosen home already has one",
                ),
                Err(error) => {
                    shell.finish(|state| {
                        state.copied = copied;
                        state.files = files;
                        state.skipped = skipped;
                        state.links = links;
                        state.bytes = bytes;
                        state.with_credentials = true;
                        state.failed = Some(error);
                    });
                    return;
                }
            }
        }
    }

    shell.finish(|state| {
        state.copied = copied;
        state.files = files;
        state.skipped = skipped;
        state.links = links;
        state.bytes = bytes;
        state.with_credentials = with_credentials;
    });
}

/// What one tree's copy did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
    pub links: usize,
}

/// Copy a tree, creating directories and never overwriting a file.
fn copy_tree(from: &Path, to: &Path) -> Result<Report, String> {
    let mut report = Report::default();
    if !from.is_dir() {
        return Err(format!("{} is not a directory any more", from.display()));
    }
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((source, target)) = stack.pop() {
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("could not create {}: {error}", target.display()))?;
        let entries = std::fs::read_dir(&source)
            .map_err(|error| format!("could not read {}: {error}", source.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let destination = target.join(entry.file_name());
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            // A link is skipped, not followed: see this module's header.
            let is_link = std::fs::symlink_metadata(&path)
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
            if is_link {
                report.links += 1;
                continue;
            }
            if meta.is_dir() {
                stack.push((path, destination));
            } else {
                match copy_file(&path, &destination)? {
                    Some(bytes) => {
                        report.files += 1;
                        report.bytes += bytes;
                    }
                    None => report.skipped += 1,
                }
            }
        }
    }
    Ok(report)
}

/// Copy one file. `Ok(None)` means the target already had it.
fn copy_file(from: &Path, to: &Path) -> Result<Option<u64>, String> {
    if to.exists() {
        return Ok(None);
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let written = std::fs::copy(from, to)
        .map_err(|error| format!("could not copy {} to {}: {error}", from.display(), to.display()))?;
    Ok(Some(written))
}

/// The app root a home sits inside, for the panel's own row.
pub fn root_of(home: &Path) -> Option<PathBuf> {
    home.parent().map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-adoptrun-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_tree_is_copied_and_nothing_in_the_source_changes() {
        let root = scratch("copy");
        let source = root.join(".dsh").join("skills");
        std::fs::create_dir_all(source.join("mermaid-diagrams")).unwrap();
        std::fs::write(source.join("mermaid-diagrams").join("SKILL.md"), b"# diagrams").unwrap();
        let target = root.join("home").join("skills");

        let report = copy_tree(&source, &target).unwrap();
        assert_eq!(report.files, 1);
        assert_eq!(report.bytes, 10);
        assert!(target.join("mermaid-diagrams").join("SKILL.md").is_file());
        // ...and the source is untouched.
        assert!(source.join("mermaid-diagrams").join("SKILL.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_that_is_already_there_is_never_overwritten() {
        let root = scratch("no-overwrite");
        let source = root.join("from");
        let target = root.join("to");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("a.txt"), b"NEW").unwrap();
        std::fs::write(target.join("a.txt"), b"OLD").unwrap();

        let report = copy_tree(&source, &target).unwrap();
        assert_eq!(report.files, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(std::fs::read(target.join("a.txt")).unwrap(), b"OLD");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_credentials_file_is_copied_byte_for_byte_and_never_parsed() {
        let root = scratch("credentials");
        let source = root.join(".dsh");
        std::fs::create_dir_all(source.join("skills")).unwrap();
        let secret_looking = b"deepseek:\n  apiKey: not-a-real-key\n";
        std::fs::write(source.join(adopt::CREDENTIALS), secret_looking).unwrap();

        let adoption = adopt::plan(&source, &root.join("home"));
        let console = Arc::new(Console::new());
        let runner = Arc::new(Adopt::new(Arc::clone(&console)));
        runner.start(adoption, true).unwrap();
        runner.join();

        let state = runner.state();
        assert!(state.failed.is_none(), "{state:?}");
        assert!(state.with_credentials);
        let written = std::fs::read(root.join("home").join(adopt::CREDENTIALS)).unwrap();
        assert_eq!(written, secret_looking, "the copy must be byte-for-byte");
        // The transcript says what happened and never a value.
        let log = console.tail(20).join("\n");
        assert!(log.contains("never read"), "{log}");
        assert!(!log.contains("not-a-real-key"), "a credential value reached the log: {log}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_run_that_cannot_start_reports_rather_than_pretends() {
        let console = Arc::new(Console::new());
        let runner = Arc::new(Adopt::new(console));
        let empty = adopt::Adoption {
            source: PathBuf::from("/nowhere"),
            target: PathBuf::from("/nowhere-else"),
            items: Vec::new(),
        };
        assert!(runner.start(empty, false).is_err());
        assert!(!runner.is_running());
    }

    #[test]
    fn a_failed_tree_is_reported_and_does_not_take_the_run_down_quietly() {
        let root = scratch("failed");
        let adoption = adopt::Adoption {
            source: root.clone(),
            target: root.join("home"),
            items: vec![adopt::Item {
                name: "sessions",
                note: "a tree that is not there",
                from: root.join("absent"),
                to: root.join("home").join("sessions"),
            }],
        };
        let console = Arc::new(Console::new());
        let runner = Arc::new(Adopt::new(Arc::clone(&console)));
        runner.start(adoption, false).unwrap();
        runner.join();
        let state = runner.state();
        assert!(state.failed.is_some(), "{state:?}");
        assert!(console.tail(10).join("\n").contains("adopt FAILED"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_line_is_human_and_says_what_was_adopted() {
        let state = AdoptState {
            running: false,
            copied: vec!["skills".into(), "sessions".into()],
            files: 12,
            skipped: 2,
            links: 1,
            bytes: 2 * 1024 * 1024,
            failed: None,
            with_credentials: true,
        };
        let line = state.line();
        assert!(line.contains("skills, sessions"), "{line}");
        assert!(line.contains("12 file(s)"), "{line}");
        assert!(line.contains("2 left alone"), "{line}");
        assert!(line.contains("2.0 MiB"), "{line}");
        assert!(line.contains("credentials file included"), "{line}");
        assert!(line.contains("links skipped"), "{line}");
    }
}
