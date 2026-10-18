//! Everything that decides WHICH harness this app runs against, and nothing that owns a
//! process.
//!
//! The app is a front door, not a supervisor: it resolves the root, the home, the pin and
//! the child's environment, and then it runs `scripts/run-web.*` - the same file a person
//! double-clicks - in the foreground. So there is no worker thread, no status record and no
//! tree-killer here any more: Ctrl+C reaches the launcher because it is the process the
//! console already has, and the launcher owns the node child exactly as it does when it is
//! started by hand.
//!
//! What is left is the half a person cannot see and a check can: [`plan`], which answers
//! "which home, which pin, which cache, which temp" before anything is spawned.

use std::path::{Path, PathBuf};

use vn_shell_core::{home, launch, options::Options, ports};

pub mod console;
pub mod env;
pub mod setup;

pub use console::Console;
pub use env::ChildEnv;
pub use setup::{EntryPoints, Setup, SetupKind, SetupStatus};

// ---------------------------------------------------------------------------
// The plan: what a start will act on, decided before anything is spawned
// ---------------------------------------------------------------------------
/// Everything the app decided before it runs a script, and every fact it prints.
#[derive(Clone, Debug)]
pub struct Plan {
    pub version: String,
    pub launch: launch::Launch,
    /// Where the app's root and the harness home are, and what had to be refused.
    /// A ladder's answer rather than an inherited path.
    pub home: home::Resolution,
    /// The npm cache a child is given, chosen by writing where npm really writes.
    pub npm_cache: Option<vn_shell_core::appdata::CacheChoice>,
    /// A temp directory to hand the child instead of the machine's - set only when a
    /// child cannot write in the machine's (`env::choose_temp`), which the harness's
    /// own spill store proved it sometimes cannot.
    pub temp: Option<PathBuf>,
    /// The directory the harness will run in, captured once. It is composed into
    /// the child, because `keystate` reads `.env` in the shell's cwd BECAUSE the
    /// harness inherits it - so one value has to serve both.
    pub workspace: Option<PathBuf>,
    /// The checkout or distribution root, when one was found. Carried here so the
    /// launch decision and the npm-cache choice see the same facts.
    pub root: Option<PathBuf>,
    /// What [`ports::choose_port`] answers right now. A HINT: the harness really does
    /// choose again, because a port that was free when this app looked may be held by
    /// the time the launcher starts.
    pub port_hint: Option<u16>,
    /// Lines worth printing: a refused home, a missing pack, a cache that had to move.
    pub notes: Vec<String>,
}

impl Plan {
    /// The harness home, when the ladder decided one.
    pub fn home_path(&self) -> Option<&Path> {
        self.home.home_path()
    }

    /// The app's own root.
    pub fn app_root(&self) -> Option<&Path> {
        self.home.app_root_path()
    }

    /// The composed environment, as one line - the whole thing, `PATH` included.
    pub fn env_line(&self) -> String {
        env::for_plan(self).line()
    }

    /// The same composition as a console sentence: the four variables this app decided,
    /// and a marker count instead of the machine's thousand-character `PATH`.
    pub fn env_summary(&self) -> String {
        env::for_plan(self).summary()
    }

    /// The app root's own words.
    pub fn app_root_origin_label(&self) -> &'static str {
        self.home.app_root_origin_label()
    }

    /// One line naming what the launcher will actually run - never what was hoped for.
    pub fn runtime_line(&self) -> String {
        match &self.launch {
            launch::Launch::Vendored { node, .. } => {
                format!("vendored runtime ({})", node.display())
            }
            launch::Launch::Installed { bin, .. } => {
                format!("already installed here, no npm ({})", bin.display())
            }
            launch::Launch::Npx => format!("npx --yes @deepseek-ai/dsh@{}", self.version),
            launch::Launch::Stub { program, .. } => {
                format!("TEST SEAM ({})", program.display())
            }
        }
    }
}

/// Decide everything a start needs, without spawning anything.
///
/// The ladders are resolved HERE, by writing where the harness will write, so the app can
/// say "this home was refused, this one is in use" the moment it opens rather than after a
/// three-minute wait for a ready line that cannot arrive.
///
/// `remembered` is a home chosen by an earlier build of this app: it sits above the
/// inherited `DSH_HOME` and below `-DshHome`.
pub fn plan(options: &Options, remembered: Option<&Path>) -> Result<Plan, String> {
    let root = launch::repo_root();
    let version = launch::resolve_version(options)?;
    // NOTHING OUTSIDE THIS APP'S OWN ROOT IS EVER THE HOME. A folder that carries
    // everything it needs must not reach into a person's profile to start, and the two
    // things a home outside it answered - a home with no pack, and a home with no key -
    // are answered by this command (which installs the pack into the home in use) and by
    // the key prompt.
    let resolved = home::from_env(options.dsh_home.as_deref(), remembered);
    let chosen = launch::choose_launch(
        root.as_deref(),
        resolved.app_root_path(),
        resolved.home_path(),
        &version,
    );
    let mut notes = resolved.notes();
    // The preflight, as a NOTE here rather than a refusal: only an explicit `-DshHome`
    // actually stops a run (see `home::Resolution::problem`).
    if let Some(problem) = resolved.problem() {
        notes.push(problem);
    }
    if let Some(note) = missing_pack_note(resolved.home_path(), launch::PROFILE) {
        notes.push(note);
    }
    if root.is_none() && matches!(chosen, launch::Launch::Npx) {
        notes.push(
            "no .dsh-version.json was found above this binary, so the pin came from -DshVersion"
                .to_string(),
        );
    }
    let (npm_cache, cache_note) = env::choose_cache(
        resolved.app_root_path(),
        resolved.home_path(),
        root.as_deref(),
    );
    if let Some(note) = cache_note {
        notes.push(note);
    }
    let (temp, temp_note) = env::choose_temp(
        resolved.app_root_path(),
        vn_shell_core::appdata::machine_temp(),
        &mut vn_shell_core::appdata::probe,
    );
    if let Some(note) = temp_note {
        notes.push(note);
    }
    Ok(Plan {
        version,
        launch: chosen,
        home: resolved,
        npm_cache,
        temp,
        workspace: std::env::current_dir().ok(),
        root,
        port_hint: ports::choose_port(options),
        notes,
    })
}

/// A friendly nudge, never a refusal - the harness runs fine without the pack, so a
/// profile that never had it installed still starts, just unadorned. This is the same
/// warning `run-web.ps1` prints, from the same source of truth: the web profile's own
/// bundle list.
///
/// The words name a command the reader can actually run. They used to name a button on a
/// window this app no longer opens, which is the same mistake in a different costume.
pub fn missing_pack_note(home: Option<&Path>, profile: &str) -> Option<String> {
    let home = home?;
    let profile_dir = home.join("profiles").join(profile);
    let manifest = profile_dir.join("package.json");
    if !manifest.is_file() {
        return Some(format!(
            "there is no {profile} profile at {} yet, so the harness will come up unadorned. \
             `vncode install` puts this pack into THIS home first, and so does a plain \
             `vncode start`",
            profile_dir.display()
        ));
    }
    let installed = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.get("dsh")?
                .get("profile")?
                .get("bundles")?
                .as_array()
                .map(|bundles| bundles.iter().any(|bundle| bundle.as_str() == Some("dsh-rightbar")))
        })
        .unwrap_or(false);
    if installed {
        None
    } else {
        Some(format!(
            "the {profile} profile at {} does not list this pack's bundles, so the harness \
             comes up unadorned (no right bar, no editor, no themes). `vncode install` adds \
             them to THIS home, and so does a plain `vncode start`",
            profile_dir.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory for THIS crate's tests: `vn-shell-core`'s helper is
    /// test-only and private to it, and a check may point both at one root.
    fn scratch_dir(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-runtime-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn the_plan_names_what_will_run_rather_than_what_was_hoped_for() {
        // -DshVersion makes the plan resolvable with no checkout at a known path,
        // which is what lets this test run from anywhere.
        let options = Options { dsh_version: Some("9.9.9".into()), ..Options::default() };
        let plan = plan(&options, None).expect("the plan must resolve with an explicit pin");
        assert_eq!(plan.version, "9.9.9");
        let line = plan.runtime_line();
        assert!(
            line.contains("vendored") || line.contains("npx") || line.contains("TEST SEAM"),
            "{line}"
        );
    }

    #[test]
    fn the_plan_always_names_a_home_and_an_app_root() {
        // The ordinary case: a home this app can write is always found, so "the plan
        // exists" and "there is a harness home" are the same statement.
        let options = Options { dsh_version: Some("9.9.9".into()), ..Options::default() };
        let plan = plan(&options, None).expect("the plan must resolve with an explicit pin");
        let home = plan.home_path().expect("a home is always decided");
        let root = plan.app_root().expect("a root is always decided");
        // The home is EITHER an inherited `DSH_HOME` that was writable (the app joins the
        // session that started it) OR the default inside the app's own root. Both are
        // correct; what must never happen is a home that is neither.
        let origin = plan.home.home.as_ref().unwrap().origin;
        match origin {
            vn_shell_core::home::Origin::Inherited | vn_shell_core::home::Origin::Flag => {}
            _ => assert_eq!(home.parent(), Some(root), "the default home must sit in the root"),
        }
        // The composed environment names the home, and never the app's own word for
        // its root - the harness knows `DSH_HOME` and nothing else.
        let line = plan.env_line();
        assert!(line.contains("DSH_HOME="), "{line}");
        assert!(line.contains(&home.display().to_string()), "{line}");
        assert!(!line.contains("VNCODE_HOME="), "{line}");
    }

    #[test]
    fn an_explicit_dshhome_that_cannot_be_written_is_a_problem_that_names_the_flag() {
        // The failure this pins, measured on a machine whose app was started from inside a
        // program that confines its children: the harness died on `EPERM ... cordis.yml`
        // three minutes after Start, and the app could have known instantly. An inherited
        // or default home falls through to one this app creates; only a `-DshHome` the
        // person typed is a refusal, and the refusal names the flag.
        let root = scratch_dir("home-problem");
        std::fs::create_dir_all(&root).unwrap();
        let blocker = root.join("blocker");
        std::fs::write(&blocker, b"a file, not a directory").unwrap();
        let impossible = blocker.join(".dsh");

        let options = Options {
            dsh_home: Some(impossible.display().to_string()),
            dsh_version: Some("9.9.9".into()),
            ..Options::default()
        };
        let plan = plan(&options, None).expect("the plan itself still resolves");
        let problem = plan.home.problem().expect("an impossible -DshHome is a problem");
        assert!(problem.contains("-DshHome"), "{problem}");
        assert!(problem.contains("blocker"), "{problem}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_profile_is_a_note_and_never_a_refusal() {
        let root = scratch_dir("missing-pack");
        std::fs::create_dir_all(root.join("profiles").join("web")).unwrap();
        let note = missing_pack_note(Some(&root), "web").expect("a note is due");
        assert!(note.contains("no web profile"), "{note}");
        // The words point at a command the reader can run, and never at a button on a
        // window this build no longer opens.
        assert!(note.contains("vncode install"), "{note}");
        assert!(!note.contains("press"), "{note}");
        // A profile with the manifest but without the pack gets the other note.
        std::fs::write(
            root.join("profiles").join("web").join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#,
        )
        .unwrap();
        let note = missing_pack_note(Some(&root), "web").expect("a note is due");
        assert!(note.contains("does not list this pack's bundles"), "{note}");
        assert!(note.contains("unadorned"), "{note}");
        // A note is a console line: no markup is rendered here, so no markup is written.
        for note in [
            missing_pack_note(Some(&root), "web").unwrap(),
            missing_pack_note(Some(&root.join("nothing")), "web").unwrap(),
        ] {
            assert!(!note.contains("**"), "a note carries markdown emphasis: {note}");
        }
        // ...and one that lists the pack gets nothing at all.
        std::fs::write(
            root.join("profiles").join("web").join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["dsh-rightbar"]}}}"#,
        )
        .unwrap();
        assert_eq!(missing_pack_note(Some(&root), "web"), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
