//! The web profile's manifest: one reader, so the panel and the runtime cannot
//! disagree about whether a home has this pack in it.
//!
//! The manifest is `<home>/profiles/<profile>/package.json` and the bundles live at
//! `dsh.profile.bundles`. Nothing here writes: this module only answers questions, and
//! everything it answers with comes from the file the HARNESS loads, not from a record
//! this app keeps.

use std::path::Path;

/// The bundle that marks this pack's presence in a profile.
///
/// One of the first layers the installer adds, and the one the launcher has always asked
/// about: a profile that lists it is adorned (right bar, editor, themes), and a profile
/// that does not is the bare harness.
pub const PACK_MARKER: &str = "dsh-rightbar";

/// The bundles a profile lists, or `None` when there is no profile there at all.
pub fn bundles(home: &Path, profile: &str) -> Option<Vec<String>> {
    let manifest = home.join("profiles").join(profile).join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let list = json.get("dsh")?.get("profile")?.get("bundles")?.as_array()?;
    Some(list.iter().filter_map(|bundle| bundle.as_str().map(str::to_string)).collect())
}

/// Whether a profile lists this pack.
pub fn has_pack(bundles: &[String]) -> bool {
    bundles.iter().any(|bundle| bundle == PACK_MARKER)
}

/// The profile directory for a home, for a message that has to name it.
pub fn directory(home: &Path, profile: &str) -> std::path::PathBuf {
    home.join("profiles").join(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => std::path::PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-profile-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn the_bundle_list_comes_from_the_file_the_harness_reads() {
        let home = scratch("bundles");
        assert_eq!(bundles(&home, "web"), None, "no profile is not an empty profile");
        let directory = home.join("profiles").join("web");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-rightbar","dsh-editor"]}}}"#,
        )
        .unwrap();
        let list = bundles(&home, "web").expect("the manifest is there");
        assert_eq!(list.len(), 3);
        assert!(has_pack(&list));
        // A bare profile is a real answer, not a missing one.
        std::fs::write(
            directory.join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#,
        )
        .unwrap();
        let list = bundles(&home, "web").expect("the manifest is still there");
        assert!(!has_pack(&list), "a bare profile must not read as adorned");
        // ...and a file that is not JSON is missing rather than a guess.
        std::fs::write(directory.join("package.json"), b"not json").unwrap();
        assert_eq!(bundles(&home, "web"), None);
        let _ = std::fs::remove_dir_all(&home);
    }
}
