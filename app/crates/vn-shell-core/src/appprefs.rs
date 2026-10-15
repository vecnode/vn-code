//! The app's own small preferences: which browser shows the harness, and which home
//! the person chose.
//!
//! It lives in the APP ROOT (`<root>/prefs.json`), not in the harness home, and that
//! is the whole reason it can exist: the home is one of the things this file decides,
//! so the record of that decision cannot live inside it. The window record moved here
//! for the same reason - see `appdata.rs`'s header.
//!
//! ## Two rules, and they are `windowstate`'s
//!
//! 1. **A record this build cannot vouch for is DISCARDED, never repaired.** A
//!    malformed file, a version this build does not know, a browser id that is not in
//!    the table, a home path that is empty: each one is simply absent, and the app
//!    falls back to what it would have done on a first run. Repairing somebody's
//!    preferences is a bigger promise than reading them.
//! 2. **It is written atomically**: a temporary file beside it, then a rename, so a
//!    crash mid-write leaves the old record rather than half of a new one.
//!
//! ## Which root it is read from, and why that is one root and not two
//!
//! The record is written into **the root the ladder chose** - the same root as the
//! window geometry, the npm cache and the home - so a portable folder, a confined run
//! and an ordinary install all remember the person's answer in the place that answer
//! belongs to. [`AppPrefs::load_from`] takes that root first and one FALLBACK second,
//! read only: the platform's own data directory, where every version before this one
//! wrote the file. Without the fallback, a person whose ladder had already fallen
//! through to `<tree>/.vncode` would have lost the home they chose - which is the
//! measured bug this exists for: the file was written under `%LOCALAPPDATA%` while the
//! root in use was beside the checkout, so the choice could never be read back and the
//! first-run question returned on every launch.

use std::path::{Path, PathBuf};

use crate::browser;
use crate::userpath;

/// The file, inside the app root.
pub const FILENAME: &str = "prefs.json";

/// The record's shape. A different number is a record this build does not read.
pub const VERSION: u64 = 1;

/// What the app remembers between runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppPrefs {
    /// A browser id from [`browser::known_ids`], or `None` for "the first one found".
    pub browser: Option<String>,
    /// The home the person chose in the panel, absolute and normalised. `None` means
    /// the ladder decides, which is the ordinary case.
    pub home: Option<PathBuf>,
}

/// What one root's `prefs.json` is.
enum Read {
    /// No file there at all: the next candidate may answer.
    Absent,
    /// A file this build cannot vouch for. The search STOPS: an older root's record
    /// must not stand in for one somebody has already written over.
    Unusable,
    Ok(AppPrefs),
}

impl AppPrefs {
    /// Read the record, or an empty one when there is nothing usable there.
    ///
    /// Never fails: a preferences file is a convenience, and an app that refused to
    /// start because its own convenience file was corrupt would be a worse app.
    pub fn load(root: Option<&Path>) -> AppPrefs {
        Self::load_from(root, None).0
    }

    /// Read the record from the root the LADDER chose, falling back to a second root,
    /// and say which of the two answered.
    ///
    /// The fallback exists for exactly one migration, and it is a real one: the app used
    /// to write this file into `appdata::app_root()` (the platform's data directory)
    /// while the window record went into the ladder's root - so on a machine whose
    /// ladder fell through to `<tree>/.vncode` the chosen home was written where the
    /// next run could not read it, and the first-run question came back every launch.
    /// Reading the platform copy once keeps that person's answer; the moment the panel
    /// saves, the record lands in the ladder's own root, and the fallback goes quiet.
    ///
    /// Nothing is ever written into the fallback: it is read, and that is all.
    pub fn load_from(primary: Option<&Path>, fallback: Option<&Path>) -> (AppPrefs, Option<PathBuf>) {
        let mut candidates: Vec<&Path> = Vec::new();
        if let Some(root) = primary {
            candidates.push(root);
        }
        if let Some(root) = fallback.filter(|fallback| Some(*fallback) != primary) {
            candidates.push(root);
        }
        for root in candidates {
            match Self::read(root) {
                Read::Ok(prefs) => return (prefs, Some(root.to_path_buf())),
                // A record this build cannot vouch for is DISCARDED, never repaired -
                // and never replaced by an older root's record either: that would
                // resurrect a choice somebody has already overwritten.
                Read::Unusable => return (AppPrefs::default(), Some(root.to_path_buf())),
                Read::Absent => continue,
            }
        }
        (AppPrefs::default(), None)
    }

    /// What one root's record is: absent, there but unusable, or usable.
    fn read(root: &Path) -> Read {
        let Ok(text) = std::fs::read_to_string(root.join(FILENAME)) else {
            return Read::Absent;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            return Read::Unusable;
        };
        if json.get("version").and_then(serde_json::Value::as_u64) != Some(VERSION) {
            return Read::Unusable;
        }
        Read::Ok(AppPrefs {
            browser: json
                .get("browser")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|id| browser::known_ids().contains(id))
                .map(str::to_string),
            home: json
                .get("home")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .filter(|path| userpath::is_plausible(path)),
        })
    }

    /// Write the record, atomically, creating the app root if it is not there.
    pub fn save(&self, root: &Path) -> Result<(), String> {
        std::fs::create_dir_all(root)
            .map_err(|error| format!("could not create {}: {error}", root.display()))?;
        let mut json = serde_json::Map::new();
        json.insert("version".to_string(), serde_json::Value::from(VERSION));
        json.insert(
            "browser".to_string(),
            match &self.browser {
                Some(id) => serde_json::Value::from(id.as_str()),
                None => serde_json::Value::Null,
            },
        );
        json.insert(
            "home".to_string(),
            match &self.home {
                Some(path) => serde_json::Value::from(path.to_string_lossy().to_string()),
                None => serde_json::Value::Null,
            },
        );
        let text = serde_json::Value::Object(json).to_string();
        let target = root.join(FILENAME);
        // Beside the target, so the rename is within one directory and therefore
        // atomic on every platform this ships on.
        let temporary = root.join(format!("{FILENAME}.tmp-{}", std::process::id()));
        std::fs::write(&temporary, text.as_bytes())
            .map_err(|error| format!("could not write {}: {error}", temporary.display()))?;
        match std::fs::rename(&temporary, &target) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = std::fs::remove_file(&temporary);
                Err(format!("could not replace {}: {error}", target.display()))
            }
        }
    }

    /// Remember a browser by id. An id this build does not know is refused rather
    /// than stored: a preferences file must not be able to name a program.
    pub fn set_browser(&mut self, id: &str) -> bool {
        let id = id.trim();
        if !browser::known_ids().contains(&id) {
            return false;
        }
        self.browser = Some(id.to_string());
        true
    }

    /// Remember a home, resolved and normalised.
    pub fn set_home(&mut self, typed: &str, cwd: Option<&Path>) -> Result<(), String> {
        let resolved = userpath::resolve(typed, cwd, crate::home::home_dir().as_deref())?;
        self.home = Some(resolved);
        Ok(())
    }

    /// Forget the remembered home, so the ladder decides again.
    pub fn clear_home(&mut self) {
        self.home = None;
    }

    /// The line the panel and the log draw.
    pub fn line(&self) -> String {
        format!(
            "browser={} · home={}",
            self.browser.as_deref().unwrap_or("the first one found"),
            self.home
                .as_deref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "chosen by the ladder".to_string())
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-prefs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn what_is_written_is_what_is_read_back() {
        let root = scratch("round-trip");
        let mut prefs = AppPrefs::default();
        assert!(prefs.set_browser("firefox"));
        prefs.set_home("/tmp/chosen-home", None).unwrap();
        prefs.save(&root).unwrap();
        assert_eq!(AppPrefs::load(Some(&root)), prefs);
        // ...and no temporary file is left beside it.
        let left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec![FILENAME.to_string()], "{left:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_record_this_build_cannot_vouch_for_is_discarded_not_repaired() {
        let root = scratch("discard");
        let write = |text: &str| std::fs::write(root.join(FILENAME), text).unwrap();

        write("not json at all");
        assert_eq!(AppPrefs::load(Some(&root)), AppPrefs::default());

        // A version this build does not read.
        write(r#"{"version":99,"browser":"firefox","home":"/tmp/x"}"#);
        assert_eq!(AppPrefs::load(Some(&root)), AppPrefs::default());

        // A browser this build does not know, and a home that is not a path: each
        // field is dropped on its own, so the good part still survives.
        write(r#"{"version":1,"browser":"netscape","home":"   "}"#);
        assert_eq!(AppPrefs::load(Some(&root)), AppPrefs::default());
        write(r#"{"version":1,"browser":"brave","home":"/tmp/ok"}"#);
        let prefs = AppPrefs::load(Some(&root));
        assert_eq!(prefs.browser.as_deref(), Some("brave"));
        assert_eq!(prefs.home.as_deref(), Some(Path::new("/tmp/ok")));

        // No file at all, and no root at all, are both the default.
        std::fs::remove_file(root.join(FILENAME)).unwrap();
        assert_eq!(AppPrefs::load(Some(&root)), AppPrefs::default());
        assert_eq!(AppPrefs::load(None), AppPrefs::default());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_record_is_read_from_the_ladder_root_and_only_falls_back_when_it_is_absent() {
        // The migration this exists for: the ladder's root is `<tree>/.vncode` and the
        // chosen home was written into the platform root by an older build. Reading the
        // fallback keeps the answer, and the root it came from is reported so the panel
        // knows where this run will save.
        let tree = scratch("fallback-tree");
        let platform = scratch("fallback-platform");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::create_dir_all(&platform).unwrap();
        let mut older = AppPrefs::default();
        older.set_home("/tmp/from-the-platform-root", None).unwrap();
        older.save(&platform).unwrap();

        let (prefs, from) = AppPrefs::load_from(Some(&tree), Some(&platform));
        assert_eq!(prefs.home.as_deref(), Some(Path::new("/tmp/from-the-platform-root")));
        assert_eq!(from.as_deref(), Some(platform.as_path()));
        // ...and nothing was written into the fallback, or into the tree, by reading.
        assert!(!tree.join(FILENAME).exists());

        // A record in the ladder's own root WINS, and the fallback is not consulted.
        let mut current = AppPrefs::default();
        current.set_home("/tmp/from-the-ladder-root", None).unwrap();
        current.save(&tree).unwrap();
        let (prefs, from) = AppPrefs::load_from(Some(&tree), Some(&platform));
        assert_eq!(prefs.home.as_deref(), Some(Path::new("/tmp/from-the-ladder-root")));
        assert_eq!(from.as_deref(), Some(tree.as_path()));

        // A record the build cannot vouch for STOPS the search: the older root's answer
        // must not stand in for one that was already written over.
        std::fs::write(tree.join(FILENAME), b"{ this is not a record }").unwrap();
        let (prefs, from) = AppPrefs::load_from(Some(&tree), Some(&platform));
        assert_eq!(prefs, AppPrefs::default());
        assert_eq!(from.as_deref(), Some(tree.as_path()));

        // With no primary root at all, the fallback still answers - which is the case
        // where the ladder found nothing writable and the app has no memory.
        std::fs::remove_file(tree.join(FILENAME)).unwrap();
        let (prefs, from) = AppPrefs::load_from(None, Some(&platform));
        assert_eq!(prefs.home.as_deref(), Some(Path::new("/tmp/from-the-platform-root")));
        assert_eq!(from.as_deref(), Some(platform.as_path()));
        let _ = std::fs::remove_dir_all(&tree);
        let _ = std::fs::remove_dir_all(&platform);
    }

    #[test]
    fn a_preferences_file_can_never_name_a_program() {
        // The security property: the only thing stored is an ID the table already
        // holds, so a hand-edited `prefs.json` cannot make the app run an arbitrary
        // program - which a stored path would.
        let mut prefs = AppPrefs::default();
        assert!(!prefs.set_browser("/bin/sh"));
        assert!(!prefs.set_browser("chrome.exe"));
        assert!(!prefs.set_browser(""));
        assert_eq!(prefs.browser, None);
        assert!(prefs.set_browser("chrome"));
        assert_eq!(prefs.browser.as_deref(), Some("chrome"));
    }

    #[test]
    fn the_line_says_what_will_happen_rather_than_what_was_stored() {
        let empty = AppPrefs::default();
        assert!(empty.line().contains("the first one found"), "{}", empty.line());
        assert!(empty.line().contains("chosen by the ladder"), "{}", empty.line());
        let mut prefs = AppPrefs::default();
        prefs.set_browser("edge");
        prefs.set_home("/tmp/home", None).unwrap();
        assert!(prefs.line().contains("browser=edge"), "{}", prefs.line());
        // The line draws the RESOLVED path, which is what the ladder will probe - so
        // it is built the same way here rather than spelled by hand.
        let resolved = userpath::resolve("/tmp/home", None, None).unwrap();
        assert!(prefs.line().contains(&resolved.display().to_string()), "{}", prefs.line());
    }

    #[test]
    fn a_chosen_home_is_resolved_and_cleared() {
        let mut prefs = AppPrefs::default();
        prefs.set_home("sub/home", Some(Path::new("/here"))).unwrap();
        assert_eq!(prefs.home.as_deref(), Some(Path::new("/here/sub/home")));
        prefs.clear_home();
        assert_eq!(prefs.home, None);
        // A path that cannot be resolved is refused rather than stored as typed.
        assert!(prefs.set_home("   ", None).is_err());
    }
}
