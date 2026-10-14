//! What the profile says about how it looks, read without a YAML dependency.
//!
//! The panel draws itself in the profile's own palette so the seam between the
//! native chrome and the rendered page is invisible rather than a dark frame
//! around a green page. The values it needs are in the profile's
//! `cordis.patch.yml`, which is a flat list of `- id: <row>` entries with a
//! `config:` block under each - so a scanner that tracks the CURRENT entry is
//! enough, and a YAML parser would be a dependency the shell does not otherwise
//! need.
//!
//! Reading is best-effort by design: a profile that has been edited by hand, or
//! one that does not exist yet, costs the shell its palette and nothing else.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The subset of a profile's configuration the panel draws with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Preferences {
    /// `ui-theme`'s `preference`: `light` or `dark`.
    pub preference: Option<String>,
    /// `ui-state`'s `theme`: an extension palette's name (`hacker`, `nord`, …).
    pub theme: Option<String>,
    /// `ui-state`'s `pageZoom`, in percent. The PAGE's zoom - the panel never
    /// applies it to itself.
    pub page_zoom: Option<u32>,
}

impl Preferences {
    /// The palette name the panel should wear.
    ///
    /// The extension theme wins over the base preference, because that is the
    /// order the harness itself applies them in: a registered theme paints over
    /// the base palette's `colorScheme`.
    pub fn palette(&self) -> &str {
        match self.theme.as_deref() {
            Some(name) if !name.is_empty() => name,
            _ => match self.preference.as_deref() {
                Some("light") => "light",
                _ => "dark",
            },
        }
    }
}

/// Read the values out of a profile patch's TEXT.
pub fn parse(text: &str) -> Preferences {
    let mut preferences = Preferences::default();
    let mut entry = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("- id:") {
            entry = rest.trim().trim_matches('"').to_string();
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            continue;
        }
        match (entry.as_str(), key) {
            ("ui-theme", "preference") => preferences.preference = Some(value.to_string()),
            ("ui-state", "theme") => preferences.theme = Some(value.to_string()),
            ("ui-state", "pageZoom") => preferences.page_zoom = value.parse::<u32>().ok(),
            _ => {}
        }
    }
    preferences
}

/// Where a profile's patch layer lives.
pub fn patch_path(home: &Path, profile: &str) -> PathBuf {
    home.join("profiles").join(profile).join("cordis.patch.yml")
}

/// Read the profile's preferences, or the defaults if it cannot be read.
pub fn read(home: Option<&Path>, profile: &str) -> Preferences {
    let Some(home) = home else {
        return Preferences::default();
    };
    match std::fs::read_to_string(patch_path(home, profile)) {
        Ok(text) => parse(&text),
        Err(_) => Preferences::default(),
    }
}

/// The profiles this home has, sorted, so the panel can name them.
pub fn profile_names(home: Option<&Path>) -> Vec<String> {
    let Some(profiles) = home.map(|home| home.join("profiles")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(profiles) else {
        return Vec::new();
    };
    let mut names: BTreeSet<String> = BTreeSet::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // `node_modules` is the installation fallback that lives beside the
        // profiles, not a profile.
        if name == "node_modules" || name.starts_with('.') {
            continue;
        }
        if entry.path().is_dir() {
            names.insert(name);
        }
    }
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real shape: a top-level list of id-targeted entries, each with its own
    /// `config:` block, and `ui-state`'s five fields beside the theme.
    const PATCH: &str = "\
# Your patch layer for this dsh profile
- id: ui-settings-general
  name: \"@deepseek-ai/dsh-client-ui-settings-general\"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: ui-theme
  name: \"@deepseek-ai/dsh-client-ui-theme\"
  config:
    preference: light
- id: agent-default-model
  name: \"@deepseek-ai/dsh-agent-default-model\"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
- id: ui-state
  name: \"dsh-ui-state\"
  config:
    pageZoom: 80
    dockHeight: 370
    sidebarWidth: 280
    rightbarWidth: 580
    theme: hacker
";

    #[test]
    fn the_real_patch_shape_is_read() {
        let preferences = parse(PATCH);
        assert_eq!(preferences.preference.as_deref(), Some("light"));
        assert_eq!(preferences.theme.as_deref(), Some("hacker"));
        assert_eq!(preferences.page_zoom, Some(80));
        // The extension theme is what the panel wears, and 80 is the PAGE's zoom.
        assert_eq!(preferences.palette(), "hacker");
    }

    #[test]
    fn a_key_in_another_entry_is_not_mistaken_for_this_one() {
        // `theme:` under some other row must not become the panel's palette -
        // this is the whole reason the scanner tracks the current entry.
        let text = "- id: agent-default-model\n  config:\n    theme: deepseek-flash\n";
        assert_eq!(parse(text).theme, None);
        // ...and `provider:`/`model:` never leak into the panel's fields either.
        let text = "- id: agent-default-model\n  config:\n    pageZoom: 120\n";
        assert_eq!(parse(text).page_zoom, None);
    }

    #[test]
    fn a_missing_or_unreadable_patch_costs_the_palette_and_nothing_else() {
        let preferences = read(None, "web");
        assert_eq!(preferences, Preferences::default());
        assert_eq!(preferences.palette(), "dark");

        let text = "- id: ui-theme\n  config:\n    preference: light\n";
        assert_eq!(parse(text).palette(), "light");
        // An unparseable zoom is "no zoom recorded", never a panic and never 0.
        let text = "- id: ui-state\n  config:\n    pageZoom: eighty\n";
        assert_eq!(parse(text).page_zoom, None);
    }

    #[test]
    fn the_patch_lives_under_the_profile_folder() {
        let path = patch_path(Path::new("/home/u/.dsh"), "web");
        assert!(path.ends_with(Path::new("profiles").join("web").join("cordis.patch.yml")));
    }

    #[test]
    fn profiles_are_listed_and_the_installation_fallback_is_not_one_of_them() {
        let root = crate::scratch::dir("profiles");
        let profiles = root.join("profiles");
        std::fs::create_dir_all(profiles.join("web")).unwrap();
        std::fs::create_dir_all(profiles.join("desktop")).unwrap();
        std::fs::create_dir_all(profiles.join("node_modules")).unwrap();
        std::fs::write(profiles.join("not-a-profile.txt"), b"x").unwrap();
        assert_eq!(profile_names(Some(&root)), vec!["desktop", "web"]);
        assert!(profile_names(None).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
