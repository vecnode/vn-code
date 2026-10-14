//! Everything a **home choice** changes, rebuilt in one place.
//!
//! The home is chosen once, on the panel's first-run screen, and it changes more than
//! the home: the location map, which profiles exist, the harness's own preferences and
//! the key state all follow it. Rebuilding that inside the panel would be a second,
//! drifting copy of what `main.rs` builds at startup - so this IS that construction, in
//! one function, and both callers use it.
//!
//! It is also the answer to "did that click take effect?": the panel re-plans through
//! this the moment a choice is made and again when a copy or an install finishes, so no
//! row it draws can describe a home the app is no longer using.

use std::path::Path;

use vn_shell_core::{keystate::KeyState, launch, prefs::Preferences};
use vn_shell_paths::{self as paths, Row};

use crate::{plan, Options, Plan};

/// What the panel and the binary both need, and nothing else.
pub struct View {
    pub plan: Plan,
    /// The location map for the plan's home, as rows.
    pub paths: Vec<Row>,
    /// The profile directories that exist in the plan's home.
    pub profiles: Vec<String>,
    /// The harness's own preferences for that home.
    pub prefs: Preferences,
    pub key_state: KeyState,
}

/// Plan, then read everything that follows from the plan.
pub fn view(options: &Options, remembered: Option<&Path>) -> Result<View, String> {
    let plan = plan(options, remembered)?;
    let profiles = vn_shell_core::prefs::profile_names(plan.home_path());
    let workspace = std::env::current_dir().ok();
    let repo = launch::repo_root();
    let rows = paths::rows(&paths::Input {
        home: plan.home_path(),
        home_origin: plan.home.row().1,
        app_root: plan.app_root(),
        repo_root: repo.as_deref(),
        workspace: workspace.as_deref(),
        profile: launch::PROFILE,
        profiles: &profiles,
    });
    let prefs = vn_shell_core::prefs::read(plan.home_path(), launch::PROFILE);
    let key_state = vn_shell_core::keystate::read(plan.home_path());
    Ok(View { plan, paths: rows, profiles, prefs, key_state })
}
