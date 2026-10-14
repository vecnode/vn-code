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

impl AppPrefs {
    /// Read the record, or an empty one when there is nothing usable there.
    ///
    /// Never fails: a preferences file is a convenience, and an app that refused to
    /// start because its own convenience file was corrupt would be a worse app.
    pub fn load(root: Option<&Path>) -> AppPrefs {
        let Some(root) = root else {
            return AppPrefs::default();
        };
        let text = match std::fs::read_to_string(root.join(FILENAME)) {
            Ok(text) => text,
            Err(_) => return AppPrefs::default(),
        };
        let json: serde_json::Value = match serde_json::from_str(&text) {
            Ok(json) => json,
            Err(_) => return AppPrefs::default(),
        };
        if json.get("version").and_then(serde_json::Value::as_u64) != Some(VERSION) {
            return AppPrefs::default();
        }
        AppPrefs {
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
        }
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
