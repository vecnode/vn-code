//! The location map the control panel's first page shows.
//!
//! It is `docs/PATHS.md` as data, and the discipline that page states is the
//! discipline here: the harness keeps all user data under ONE root with the same
//! shape on all three operating systems, the pack's own state lives under it too,
//! and the only things outside it are named (the npm cache, the pnpm store, the
//! vendored runtime) because those are the ones a stuck machine needs to find.
//!
//! Two rules are structural rather than commented:
//!
//! - a row exists even when its path does NOT, so the panel can say "missing"
//!   instead of hiding the thing the reader is looking for;
//! - there is no accessor that returns a file's CONTENT. The credentials row
//!   carries a path and a presence flag, which is the whole of what this crate
//!   knows about a credential.

use std::path::{Path, PathBuf};

/// What a row is, so the panel can group and colour it without parsing labels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The harness home itself, and the reason for it.
    Home,
    /// Something the harness owns.
    Harness,
    /// Something this pack owns under the home.
    Pack,
    /// Something outside the home that the shell needs to name.
    Outside,
    /// The model credential FILE. Path and presence only.
    Credentials,
    /// This shell's own record.
    Shell,
    /// The folder being worked in.
    Workspace,
}

/// One line of the map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// Stable id, for tests and for the panel's own layout.
    pub key: &'static str,
    pub label: &'static str,
    /// `None` only when nothing could be resolved at all.
    pub path: Option<PathBuf>,
    /// Why this path, or what it currently holds. Never a file's content.
    pub note: String,
    pub kind: Kind,
}

impl Row {
    pub fn exists(&self) -> bool {
        self.path.as_ref().map(|path| path.exists()).unwrap_or(false)
    }

    /// What the row says about itself: present or not, plus the note.
    pub fn state(&self) -> &'static str {
        match (&self.path, self.exists()) {
            (None, _) => "unknown",
            (Some(_), true) => "present",
            (Some(_), false) => "missing",
        }
    }

    /// The size of a directory row, or of a file row.
    pub fn size(&self) -> Option<u64> {
        let path = self.path.as_ref()?;
        if path.is_dir() {
            dir_size(path, SIZE_BUDGET)
        } else if path.is_file() {
            std::fs::metadata(path).ok().map(|meta| meta.len())
        } else {
            None
        }
    }
}

/// Everything a row set needs to know.
pub struct Input<'a> {
    /// The harness home as this app resolved it, for REPORTING only.
    pub home: Option<&'a Path>,
    /// The origin's own words, from `vn_shell_core::home::Origin::label`.
    pub home_origin: &'a str,
    /// The app's own root (`$VNCODE_HOME`): the furniture this app owns, and the
    /// directory the home sits inside. `None` when even that could not be written.
    pub app_root: Option<&'a Path>,
    /// Where `.dsh-version.json` was found, if it was.
    pub repo_root: Option<&'a Path>,
    /// The directory the shell was started in.
    pub workspace: Option<&'a Path>,
    /// The profile this shell will start the harness with.
    pub profile: &'a str,
    /// The profiles this home has, for the profiles row's note.
    pub profiles: &'a [String],
}

/// The map, in reading order: the app's own root, the home, what the harness owns,
/// what the pack owns, then the few things outside it.
pub fn rows(input: &Input<'_>) -> Vec<Row> {
    let mut rows = Vec::new();
    let home = input.home;

    // The app's own root first, because it is the one folder this app created and the
    // one a reader can move, back up or delete without touching the harness.
    rows.push(Row {
        key: "vncode-root",
        label: "vncode root",
        path: input.app_root.map(Path::to_path_buf),
        note: "this app's own root: the window record and the npm cache, and the home inside it"
            .to_string(),
        kind: Kind::Shell,
    });

    rows.push(Row {
        key: "home",
        label: "harness home",
        path: home.map(Path::to_path_buf),
        note: input.home_origin.to_string(),
        kind: Kind::Home,
    });

    let under_home: [(&'static str, &'static str, &'static str); 5] = [
        ("profiles", "profiles", "one folder per profile; the profile is mostly links, so installing needs no registry"),
        ("sessions", "sessions", "one file per conversation - the durable transcript"),
        ("storages", "storages", "workspace.json and the session projection caches"),
        ("skills", "skills", "the skills the harness loads, including the ones this pack copies"),
        ("attachments", "attachments", "files pasted or attached into a conversation"),
    ];
    for (key, label, note) in under_home {
        let note = if key == "profiles" && !input.profiles.is_empty() {
            format!("{note} - here: {}", input.profiles.join(", "))
        } else {
            note.to_string()
        };
        rows.push(Row {
            key,
            label,
            path: home.map(|home| home.join(key)),
            note,
            kind: Kind::Harness,
        });
    }

    // The pack's own trees. Three are caches with a ceiling and one is the single
    // PROGRAM the pack writes (only after the bytes match the SHA-256 it pins).
    let pack: [(&'static str, &'static str, &'static str, &'static str); 4] = [
        ("dsh-pdf", "dsh-pdf artifacts", "PDF parse cache", "artifacts"),
        ("dsh-diagrams", "dsh-diagrams artifacts", "diagram artifact cache and the shared library", "artifacts"),
        ("dsh-media", "dsh-media bin", "the provisioned ffmpeg copy - absent where ffmpeg is on PATH", "bin"),
        ("dsh-media", "dsh-media playable", "the browser-playable remux cache", "playable"),
    ];
    for (package, label, note, child) in pack {
        rows.push(Row {
            key: match (package, child) {
                ("dsh-pdf", _) => "cache-pdf",
                ("dsh-diagrams", _) => "cache-diagrams",
                (_, "bin") => "cache-media-bin",
                _ => "cache-media-playable",
            },
            label,
            path: home.map(|home| home.join(package).join(child)),
            note: note.to_string(),
            kind: Kind::Pack,
        });
    }

    // The credential FILE. A path and a presence flag; the shell has no code that
    // reads it, which is why the note can say so and be true.
    rows.push(Row {
        key: "credentials",
        label: "model credential",
        path: home.map(|home| home.join(".credentials.yaml")),
        note: "the harness's own file - this shell names it and never reads it".to_string(),
        kind: Kind::Credentials,
    });

    rows.push(Row {
        key: "record",
        label: "window record",
        // The APP ROOT, not the home: the geometry is this app's furniture and must
        // survive a `-DshHome` that points at a folder shared with run-web.
        path: input.app_root.map(vn_shell_core::windowstate::state_path),
        note: "this shell's size and position, discarded rather than repaired if unusable"
            .to_string(),
        kind: Kind::Shell,
    });

    // Outside the home: the three things a stuck machine actually needs named.
    rows.push(Row {
        key: "runtime",
        label: "vendored runtime",
        path: input.repo_root.map(|root| root.join("runtime").join(vn_shell_core::launch::host_rid())),
        note: "node + harness + VENDOR.json; all three or the shell falls back to npx".to_string(),
        kind: Kind::Outside,
    });
    rows.push(Row {
        key: "npm-cache",
        label: "npm / npx cache",
        path: npm_cache_root(),
        note: "used only by the npx fallback, which points npm_config_cache at the app's own root"
            .to_string(),
        kind: Kind::Outside,
    });
    rows.push(Row {
        key: "pnpm-store",
        label: "pnpm store",
        path: pnpm_store_root(),
        note: "the store the profile was verified against".to_string(),
        kind: Kind::Outside,
    });

    rows.push(Row {
        key: "repo",
        label: "checkout",
        path: input.repo_root.map(Path::to_path_buf),
        note: "where .dsh-version.json, and so the pin, was found".to_string(),
        kind: Kind::Outside,
    });
    rows.push(Row {
        key: "workspace",
        label: "workspace",
        path: input.workspace.map(Path::to_path_buf),
        note: format!("the folder this shell was started in; the {} profile runs here", input.profile),
        kind: Kind::Workspace,
    });

    rows
}

/// The per-OS npm cache root, from `docs/PATHS.md`'s own table.
pub fn npm_cache_root() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("npm-cache"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".npm"))
    }
}

/// The per-OS pnpm store root, from the same table.
pub fn pnpm_store_root() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("pnpm").join("store"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/pnpm/store"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/pnpm/store"))
    }
}

/// How many directory entries a size is allowed to visit.
///
/// The panel asks for sizes, and a cache with a million tiny files must not make
/// the window stop responding. Past the budget the answer is "at least this much",
/// which the caller shows as a `+`.
pub const SIZE_BUDGET: usize = 20_000;

/// The size of a directory tree, bounded by `budget` entries.
pub fn dir_size(root: &Path, budget: usize) -> Option<u64> {
    if !root.exists() {
        return None;
    }
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > budget {
                return Some(total);
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Some(total)
}

/// Bytes in words: `0 B`, `512 B`, `1.5 KiB`, `223 MiB`, `8.0 GiB`.
pub fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(home: Option<&'a Path>, profiles: &'a [String]) -> Input<'a> {
        Input {
            home,
            home_origin: "this app's own home (the default)",
            app_root: home.and_then(Path::parent),
            repo_root: None,
            workspace: None,
            profile: "web",
            profiles,
        }
    }

    #[test]
    fn every_row_docs_paths_names_is_present() {
        // The map is only useful if it is COMPLETE: a reader looking for the
        // diagram cache and not finding it learns nothing about where it is.
        let profiles = vec!["desktop".to_string(), "web".to_string()];
        let root = PathBuf::from("/home/u/.vncode/home");
        let rows = rows(&input(Some(&root), &profiles));
        let keys: Vec<&str> = rows.iter().map(|row| row.key).collect();
        for expected in [
            "vncode-root",
            "home",
            "profiles",
            "sessions",
            "storages",
            "skills",
            "attachments",
            "cache-pdf",
            "cache-diagrams",
            "cache-media-bin",
            "cache-media-playable",
            "credentials",
            "record",
            "runtime",
            "npm-cache",
            "pnpm-store",
            "repo",
            "workspace",
        ] {
            assert!(keys.contains(&expected), "the map has no {expected} row: {keys:?}");
        }
    }

    #[test]
    fn the_home_row_carries_the_reason_it_is_that_path() {
        // A path with no reason is what made the old splash ambiguous: a reader
        // could not tell whether they had set the home or the app had.
        let root = PathBuf::from("/home/u/.vncode/home");
        let rows = rows(&input(Some(&root), &[]));
        let home = rows.iter().find(|row| row.key == "home").unwrap();
        assert_eq!(home.path.as_deref(), Some(root.as_path()));
        assert!(home.note.contains("app's own home"), "{}", home.note);
        assert_eq!(home.kind, Kind::Home);
        // ...and the app's root is its parent, named in its own row.
        let app_root = rows.iter().find(|row| row.key == "vncode-root").unwrap();
        assert_eq!(app_root.path.as_deref(), Some(Path::new("/home/u/.vncode")));
    }

    #[test]
    fn the_window_record_follows_the_app_root_and_not_the_home() {
        // The M0 rule `appdata`'s header argues for: the geometry is this app's
        // furniture, so a `-DshHome` pointing at a shared `~/.dsh` does not drag it
        // into somebody else's folder.
        let home = PathBuf::from("/app/vncode/home");
        let app_root = home.parent().unwrap().to_path_buf();
        let elsewhere = PathBuf::from("/home/u/.dsh");
        let rows = rows(&Input {
            home: Some(&elsewhere),
            home_origin: "from -DshHome",
            app_root: Some(&app_root),
            repo_root: None,
            workspace: None,
            profile: "web",
            profiles: &[],
        });
        let record = rows.iter().find(|row| row.key == "record").unwrap();
        let path = record.path.clone().unwrap();
        assert!(path.starts_with("/app/vncode"), "{}", path.display());
        assert!(!path.starts_with("/home/u/.dsh"), "{}", path.display());
    }

    #[test]
    fn a_row_exists_even_when_its_path_does_not() {
        // "missing" is information; a hidden row is not. Every row here names a
        // path because the input resolved everything a row can need - and the rows
        // that live under the home are the ones this can assert are absent.
        let root = PathBuf::from("/definitely/not/here/.dsh");
        let app_root = PathBuf::from("/definitely/not/here/app");
        let repo = PathBuf::from("/definitely/not/here/repo");
        let workspace = PathBuf::from("/definitely/not/here/work");
        let rows = rows(&Input {
            home: Some(&root),
            home_origin: "the harness's own default (this shell passes none)",
            app_root: Some(&app_root),
            repo_root: Some(&repo),
            workspace: Some(&workspace),
            profile: "web",
            profiles: &[],
        });
        for row in &rows {
            assert!(row.path.is_some(), "{} is a row with no path at all", row.key);
        }
        for key in [
            "vncode-root",
            "home",
            "profiles",
            "sessions",
            "storages",
            "skills",
            "attachments",
            "cache-pdf",
            "cache-diagrams",
            "cache-media-bin",
            "cache-media-playable",
            "credentials",
            "record",
            "runtime",
        ] {
            let row = rows.iter().find(|row| row.key == key).unwrap();
            assert!(!row.exists(), "{key} claims to exist under a home that does not");
            assert_eq!(row.state(), "missing");
        }
    }

    #[test]
    fn with_no_home_the_own_rows_say_unknown_rather_than_guessing() {
        let rows = rows(&input(None, &[]));
        let home = rows.iter().find(|row| row.key == "home").unwrap();
        assert_eq!(home.path, None);
        assert_eq!(home.state(), "unknown");
        // The rows that live under the home must not invent a parent.
        for key in ["sessions", "skills", "credentials", "record", "vncode-root"] {
            let row = rows.iter().find(|row| row.key == key).unwrap();
            assert_eq!(row.path, None, "{key} invented a path with no home");
        }
    }

    #[test]
    fn the_profiles_row_names_the_profiles_it_found() {
        let profiles = vec!["desktop".to_string(), "web".to_string()];
        let root = PathBuf::from("/home/u/.dsh");
        let rows = rows(&input(Some(&root), &profiles));
        let row = rows.iter().find(|row| row.key == "profiles").unwrap();
        assert!(row.note.contains("desktop, web"), "{}", row.note);
    }

    #[test]
    fn the_credentials_row_is_a_path_and_nothing_else() {
        // Structural, not commented: there is no function in this crate that
        // returns a file's contents, so a row cannot carry a key even by accident.
        let rows = rows(&input(Some(Path::new("/home/u/.dsh")), &[]));
        let row = rows.iter().find(|row| row.key == "credentials").unwrap();
        assert_eq!(row.kind, Kind::Credentials);
        assert!(row.path.as_ref().unwrap().ends_with(".credentials.yaml"));
        assert!(row.note.contains("never reads it"), "{}", row.note);
    }

    /// A scratch directory for this crate's tests.
    ///
    /// `VNCODE_TEST_DIR` first, for the same reason `vn-shell-core` reads it: a
    /// host that denies the system temp directory would otherwise fail tests that
    /// have nothing to do with the change under test.
    fn scratch_dir(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-paths-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn a_size_is_measured_and_a_missing_path_has_none() {
        let root = scratch_dir("size");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), vec![0u8; 1500]).unwrap();
        std::fs::write(root.join("sub").join("b.txt"), vec![0u8; 500]).unwrap();
        assert_eq!(dir_size(&root, SIZE_BUDGET), Some(2000));
        assert_eq!(dir_size(&root.join("absent"), SIZE_BUDGET), None);
        // The budget stops the walk rather than running to the end of a big tree.
        assert!(dir_size(&root, 1).unwrap() < 2000);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sizes_are_human_readable_at_the_boundaries() {
        assert_eq!(human(0), "0 B");
        assert_eq!(human(512), "512 B");
        assert_eq!(human(1024), "1.0 KiB");
        assert_eq!(human(1536), "1.5 KiB");
        assert_eq!(human(223 * 1024 * 1024), "223.0 MiB");
        assert_eq!(human(8 * 1024 * 1024 * 1024), "8.0 GiB");
    }

    #[test]
    fn the_two_outside_roots_follow_the_platform_table() {
        // These are the paths `docs/PATHS.md` states per OS; the test asserts the
        // shape of THIS platform's answer rather than all three, because only one
        // of them can be right here.
        if let Some(cache) = npm_cache_root() {
            if cfg!(target_os = "windows") {
                assert!(cache.ends_with("npm-cache"), "{}", cache.display());
            } else {
                assert!(cache.ends_with(".npm"), "{}", cache.display());
            }
        }
        if let Some(store) = pnpm_store_root() {
            let text = store.display().to_string();
            if cfg!(target_os = "windows") {
                assert!(text.ends_with("pnpm\\store") || text.ends_with("pnpm/store"), "{text}");
            } else if cfg!(target_os = "macos") {
                assert!(text.ends_with("Library/pnpm/store"), "{text}");
            } else {
                assert!(text.ends_with(".local/share/pnpm/store"), "{text}");
            }
        }
    }
}
