//! Where the app's root is, where the harness home is, and the rule that neither is
//! inherited by accident.
//!
//! `DSH_HOME` names the harness's OWN folder - the one holding `.credentials.yaml`,
//! `sessions/`, `profiles/` and the pack's caches. It is NOT the user's home, so a
//! shell that passed `%USERPROFILE%` there would boot a second, unadorned harness
//! inside it: a profile with none of this pack's bundles and none of the user's
//! sessions. Every rule below exists to make that mistake impossible, and the panel
//! SHOWS the outcome rather than hiding it.
//!
//! ## Two ladders, and the second one inside the first
//!
//! Since M0 the app owns a root, and the harness home is a directory inside it:
//!
//! * **the app root** (`$VNCODE_HOME`): `VNCODE_HOME` in the environment, else
//!   `<OS data root>/vncode`, else `<tree>/.vncode`, else a named failure. It holds
//!   the furniture - the window record, the preferences, the npm cache - and the home.
//! * **the harness home**: `-DshHome` (strict: a refusal ends the run, because an
//!   explicit instruction is never silently ignored), else the home this person chose
//!   in the panel (remembered in the app root), else an inherited `DSH_HOME` that is
//!   writable, else `<app root>/home`.
//!
//! The harness's own `~/.dsh` default is deliberately NOT a candidate: it belongs to
//! whichever harness used it first (`scripts\run-web.bat`, `npx dsh web`, another
//! installation entirely). It is an *input* - the panel offers to USE it or to ADOPT
//! a copy of it, and both are one click - but the app never walks to it on its own.
//!
//! ## Every candidate is a cleaned-up path
//!
//! Every rung goes through [`crate::userpath`] first: `~` is expanded the way the
//! harness expands it, a relative path is resolved against the directory the app was
//! started in, `.`/`..` are folded lexically, and a NUL or an empty string is refused
//! by name. What is EXPORTED, recorded and shown is the real path
//! (`userpath::canonical`), so two spellings of one home never look like two homes -
//! and a rung whose text cannot be turned into a path at all is carried as a refusal
//! with its reason rather than skipped silently.
//!
//! ## Why a home can be unwritable at all
//!
//! Measured on the machine this was written on: `%USERPROFILE%\.dsh` is owned by the
//! signed-in account and takes a write; the same directory refuses a process whose
//! PARENT confines what its children may write (an agent session, an IDE runner, a
//! CI sandbox - this repository's own checks run inside one). An elevated run can
//! also leave ACLs on it, and a checkout can sit on a read-only mount. The old build
//! answered all three with one sentence asking the person to start it differently,
//! which cannot fix a confinement; this one answers with a root it created and
//! proved, and NAMES every candidate it refused.

use std::fmt;
use std::path::{Path, PathBuf};

use crate::appdata::Probed;

/// Which candidate decided a root or a home. The panel prints this, so a reader can
/// tell "I set this" from "the app chose it".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// `-DshHome` was given.
    Flag,
    /// The home this person chose in the panel, remembered in the app root.
    Remembered,
    /// `DSH_HOME` was inherited from this shell's own environment.
    Inherited,
    /// This app's own home, inside the root.
    Owned,
    /// `VNCODE_HOME` named the app's root.
    NamedRoot,
    /// The platform's own per-user data root, plus `vncode`.
    PlatformRoot,
    /// The folder beside the checkout: `<tree>/.vncode`.
    TreeRoot,
}

impl Origin {
    pub fn label(self) -> &'static str {
        match self {
            Origin::Flag => "from -DshHome",
            Origin::Remembered => "the home you chose in this panel",
            Origin::Inherited => "from the inherited DSH_HOME",
            Origin::Owned => "this app's own home (the default)",
            Origin::NamedRoot => "from VNCODE_HOME",
            Origin::PlatformRoot => "this app's root in the platform's data directory",
            Origin::TreeRoot => "beside the checkout, because nothing else could be written",
        }
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// A candidate that was tried and could not be used, with the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub path: PathBuf,
    pub reason: String,
}

impl Refusal {
    /// One line, for the log and the panel.
    pub fn line(&self) -> String {
        format!("{} was refused: {}", self.path.display(), self.reason)
    }
}

/// One rung of a ladder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// What will be probed. Already cleaned by `userpath` when it could be.
    pub path: PathBuf,
    pub origin: Origin,
    /// A refusal here ENDS the ladder instead of falling through. Only `-DshHome`
    /// sets it: the person named that path, and quietly using another one would be
    /// answering a question they did not ask.
    pub strict: bool,
    /// Set when the text could not be turned into a path at all (empty, a NUL, a
    /// relative path with no readable working directory). The rung is then refused
    /// without the filesystem being asked anything.
    pub problem: Option<String>,
}

/// The rung that was used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    /// The REAL path: what is exported to the harness, recorded and drawn.
    pub chosen: PathBuf,
    pub origin: Origin,
    /// Whether this app created it. The panel says so, and only a directory this app
    /// created is ever hardened (`appdata::harden_if_created`).
    pub created: bool,
    /// Everything refused before it, in the order it was refused.
    pub refused: Vec<Refusal>,
}

impl Selection {
    /// The panel's row: the path, and always the reason.
    pub fn row(&self) -> (String, &'static str) {
        (self.chosen.display().to_string(), self.origin.label())
    }
}

/// What the app decided, and what it had to refuse to get there.
///
/// `app_root` is `None` only when nothing anywhere could be written - in which case
/// the app still opens (it simply has no memory), says why, and refuses to start a
/// harness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub app_root: Option<PathBuf>,
    /// Which rung of the root ladder was used, for the panel's own row.
    pub app_root_origin: Option<Origin>,
    pub home: Option<Selection>,
    /// The app root ladder's refusals, then the home ladder's.
    pub refused: Vec<Refusal>,
    /// A `-DshHome` was refused: the run must stop and say so.
    pub strict: bool,
}

impl Resolution {
    /// The harness home, when one was decided.
    pub fn home_path(&self) -> Option<&Path> {
        self.home.as_ref().map(|selection| selection.chosen.as_path())
    }

    /// The app's root, when one was decided.
    pub fn app_root_path(&self) -> Option<&Path> {
        self.app_root.as_deref()
    }

    /// The app root's own words, for the panel's `vncode` row.
    pub fn app_root_origin_label(&self) -> &'static str {
        self.app_root_origin.map(Origin::label).unwrap_or("unknown")
    }

    /// Whether the home in use was created by this app - the panel says so, because
    /// "I made this" and "I joined this" are different promises.
    pub fn home_created(&self) -> bool {
        self.home.as_ref().map(|selection| selection.created).unwrap_or(false)
    }

    /// The panel's home row: the path when there is one, and always the reason.
    pub fn row(&self) -> (String, &'static str) {
        match self.home.as_ref() {
            Some(selection) => selection.row(),
            None => ("unknown".to_string(), "no home could be written anywhere"),
        }
    }

    /// Why no harness can be started here, if none can - one sentence, naming the
    /// flag when a flag is the reason, then every candidate and its own error.
    ///
    /// `None` means the home is usable, which is the ordinary case even under a
    /// parent that confines its children: the app creates a root the confinement
    /// grants.
    pub fn problem(&self) -> Option<String> {
        if self.home.is_some() {
            return None;
        }
        let mut sentence = if self.strict {
            let named = self
                .refused
                .first()
                .map(|refusal| refusal.path.display().to_string())
                .unwrap_or_default();
            format!(
                "-DshHome names {named}, which this account cannot write in, so the harness cannot compose its profile there and will not start."
            )
        } else {
            "no harness home could be created: every candidate was refused, and the harness cannot compose its profile without one.".to_string()
        };
        sentence.push_str(" Every candidate and its own error:");
        for refusal in &self.refused {
            sentence.push_str(&format!("\n  - {}: {}", refusal.path.display(), refusal.reason));
        }
        if !self.strict {
            sentence.push_str(
                "\nPass -DshHome <a path this account can write in> to choose one yourself.",
            );
        }
        Some(sentence)
    }

    /// One line per refusal, for the log and the panel's notes.
    pub fn notes(&self) -> Vec<String> {
        self.refused.iter().map(Refusal::line).collect()
    }
}

/// Everything a resolution reads, so the whole ladder is a `cargo test` case.
#[derive(Clone, Debug, Default)]
pub struct Inputs<'a> {
    /// `VNCODE_HOME` in the environment.
    pub named_root: Option<&'a str>,
    /// `-DshHome`.
    pub flag: Option<&'a str>,
    /// The home this person chose in the panel, remembered in the app root.
    pub remembered: Option<&'a Path>,
    /// `DSH_HOME` inherited from whatever started this app.
    pub inherited: Option<&'a str>,
    /// The platform's own per-user data root.
    pub data_root: Option<&'a Path>,
    /// Where `.dsh-version.json` was found.
    pub tree_root: Option<&'a Path>,
    /// The directory the app was started in: what a relative path resolves against.
    pub cwd: Option<&'a Path>,
    /// The user's home, for a leading `~`.
    pub user_home: Option<&'a Path>,
}

/// Build a rung from typed text, carrying a cleaning failure as the rung's problem.
fn candidate(
    typed: &str,
    origin: Origin,
    strict: bool,
    inputs: &Inputs<'_>,
) -> Option<Candidate> {
    if typed.trim().is_empty() {
        return None;
    }
    Some(match crate::userpath::resolve(typed, inputs.cwd, inputs.user_home) {
        Ok(path) => Candidate { path, origin, strict, problem: None },
        // The path cannot be turned into something a process may be given. It is
        // still a rung, so the reason reaches the panel instead of vanishing.
        Err(reason) => Candidate {
            path: PathBuf::from(typed.trim()),
            origin,
            strict,
            problem: Some(reason),
        },
    })
}

/// The app root ladder, as data.
///
/// The first rung that passes the probe wins; there is no strict rung, because
/// nothing on this ladder was named by a person in a way that outranks a working
/// alternative - the point is that SOMETHING writable is found rather than nothing.
pub fn root_candidates(inputs: &Inputs<'_>) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    if let Some(named) = inputs.named_root {
        candidates.extend(candidate(named, Origin::NamedRoot, false, inputs));
    }
    if let Some(data_root) = inputs.data_root {
        candidates.push(Candidate {
            path: crate::appdata::root_in(data_root),
            origin: Origin::PlatformRoot,
            strict: false,
            problem: None,
        });
    }
    if let Some(tree_root) = inputs.tree_root {
        candidates.push(Candidate {
            path: crate::appdata::tree_root(tree_root),
            origin: Origin::TreeRoot,
            strict: false,
            problem: None,
        });
    }
    candidates
}

/// The harness home ladder, as data.
///
/// `-DshHome` is the only strict rung. The remembered choice and an inherited
/// `DSH_HOME` that cannot be written fall THROUGH with a line saying so: neither is a
/// reason to refuse to start, and refusing there is exactly the dead end this
/// revision removes.
pub fn home_candidates(inputs: &Inputs<'_>, app_root: Option<&Path>) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    if let Some(flag) = inputs.flag {
        candidates.extend(candidate(flag, Origin::Flag, true, inputs));
    }
    if let Some(remembered) = inputs.remembered {
        candidates.push(Candidate {
            path: remembered.to_path_buf(),
            origin: Origin::Remembered,
            strict: false,
            problem: None,
        });
    }
    if let Some(inherited) = inputs.inherited {
        candidates.extend(candidate(inherited, Origin::Inherited, false, inputs));
    }
    if let Some(root) = app_root {
        candidates.push(Candidate {
            path: crate::appdata::owned_home(root),
            origin: Origin::Owned,
            strict: false,
            problem: None,
        });
    }
    candidates
}

/// Walk a ladder, proving each rung with `probe`. Pure.
///
/// Every rung is probed in order; the first `Ok` wins and carries the refusals that
/// came before it. A rung whose text could not even be cleaned is refused with that
/// reason and no filesystem call. A strict rung that fails ends the walk immediately -
/// the caller gets `Err` with the refusals, and `Resolution::strict` is what turns
/// that into the sentence naming the flag.
pub fn select(
    candidates: &[Candidate],
    probe: &mut impl FnMut(&Path) -> Result<Probed, String>,
) -> Result<Selection, Vec<Refusal>> {
    let mut refused = Vec::new();
    for candidate in candidates {
        if let Some(reason) = candidate.problem.clone() {
            refused.push(Refusal { path: candidate.path.clone(), reason });
            if candidate.strict {
                return Err(refused);
            }
            continue;
        }
        match probe(&candidate.path) {
            Ok(probed) => {
                return Ok(Selection {
                    chosen: probed.path,
                    origin: candidate.origin,
                    created: probed.created,
                    refused,
                })
            }
            Err(reason) => {
                refused.push(Refusal { path: candidate.path.clone(), reason });
                if candidate.strict {
                    return Err(refused);
                }
            }
        }
    }
    Err(refused)
}

/// Resolve both ladders against a probe. Pure, so precedence, the fall-through, the
/// remembered choice and the refusals are `cargo test` cases.
pub fn resolve_with(
    inputs: &Inputs<'_>,
    probe: &mut impl FnMut(&Path) -> Result<Probed, String>,
) -> Resolution {
    let mut refused = Vec::new();
    let (app_root, app_root_origin) = match select(&root_candidates(inputs), probe) {
        Ok(selection) => {
            refused.extend(selection.refused.iter().cloned());
            (Some(selection.chosen), Some(selection.origin))
        }
        Err(root_refusals) => {
            // Nothing writable at all. There is no home to decide either, and the
            // refusals are the whole answer.
            refused.extend(root_refusals);
            return Resolution {
                app_root: None,
                app_root_origin: None,
                home: None,
                refused,
                strict: false,
            };
        }
    };

    match select(&home_candidates(inputs, app_root.as_deref()), probe) {
        Ok(selection) => {
            refused.extend(selection.refused.iter().cloned());
            Resolution { app_root, app_root_origin, home: Some(selection), refused, strict: false }
        }
        Err(home_refusals) => {
            let strict = inputs.flag.map(str::trim).is_some_and(|value| !value.is_empty());
            let mut all = refused;
            all.extend(home_refusals);
            Resolution { app_root, app_root_origin, home: None, refused: all, strict }
        }
    }
}

/// Resolve against this process's own environment and this machine's real
/// filesystem - the probe WRITES, which is the only proof this app accepts.
///
/// `remembered` is the home the person chose in the panel, read from the app root by
/// the caller (so this function reads no preferences of its own).
pub fn from_env(flag: Option<&str>, remembered: Option<&Path>) -> Resolution {
    let named_root = std::env::var("VNCODE_HOME").ok();
    let inherited = std::env::var("DSH_HOME").ok();
    let data_root = crate::appdata::data_root();
    let tree = crate::launch::repo_root();
    let cwd = std::env::current_dir().ok();
    let user_home = home_dir();
    let inputs = Inputs {
        named_root: named_root.as_deref(),
        flag,
        remembered,
        inherited: inherited.as_deref(),
        data_root: data_root.as_deref(),
        tree_root: tree.as_deref(),
        cwd: cwd.as_deref(),
        user_home: user_home.as_deref(),
    };
    resolve_with(&inputs, &mut crate::appdata::probe)
}

/// Whether a directory has the shape of a harness home.
///
/// Used for one decision only: whether the panel should offer to USE an existing
/// installation, or to ADOPT a copy of it. A folder with a profile, sessions, the
/// credential file or the storages tree is somebody's harness; an empty folder, or a
/// folder of holiday photos, is not - and offering to adopt either would be noise.
pub fn looks_like_a_harness_home(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    ["profiles", "sessions", "storages", ".credentials.yaml"]
        .iter()
        .any(|name| path.join(name).exists())
}

/// Which variable names the user's home directory, first match winning.
///
/// Windows is asked for `USERPROFILE` first because that is the variable Node's own
/// `os.homedir()` reads there - and `keystate` uses it to describe where a
/// credentials file could be. It is NOT used to choose the harness home: see this
/// module's header.
pub fn pick_home_variable<'a>(
    user_profile: Option<&'a str>,
    home: Option<&'a str>,
    is_windows: bool,
) -> Option<&'a str> {
    let candidates: [Option<&'a str>; 2] = if is_windows {
        [user_profile, home]
    } else {
        [home, user_profile]
    };
    candidates
        .into_iter()
        .flatten()
        .find(|value| !value.trim().is_empty())
}

/// The user's home directory, resolved the way the harness resolves it.
pub fn home_dir() -> Option<PathBuf> {
    let user_profile = std::env::var("USERPROFILE").ok();
    let home = std::env::var("HOME").ok();
    pick_home_variable(user_profile.as_deref(), home.as_deref(), cfg!(target_os = "windows"))
        .map(PathBuf::from)
}

/// The harness's own default home under a user home: `~/.dsh`.
///
/// NOT a candidate this app chooses on its own. It names the folder the panel offers
/// to use or adopt, and the one `-DshHome %USERPROFILE%\.dsh` selects when a person
/// asks for the app and `run-web` to share a home.
pub fn default_dsh_home(user_home: &Path) -> PathBuf {
    user_home.join(".dsh")
}

/// The harness home this machine already has, for the panel's offer and for `adopt`.
pub fn existing_default_home() -> Option<PathBuf> {
    home_dir().map(|user_home| default_dsh_home(&user_home))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A prober over a fixed set of paths: the ladder logic is what is under test,
    /// not the filesystem.
    fn prober<'a>(allowed: &'a [&'a str]) -> impl FnMut(&Path) -> Result<Probed, String> + 'a {
        move |path: &Path| {
            if allowed.iter().any(|allowed| Path::new(allowed) == path) {
                Ok(Probed { path: path.to_path_buf(), created: false })
            } else {
                Err("not writable: access is denied".to_string())
            }
        }
    }

    /// Inputs for a machine with no environment at all, plus whatever a case needs.
    fn inputs<'a>() -> Inputs<'a> {
        Inputs {
            data_root: Some(Path::new("/data")),
            tree_root: Some(Path::new("/repo")),
            cwd: Some(Path::new("/cwd")),
            user_home: Some(Path::new("/home/someone")),
            ..Inputs::default()
        }
    }

    #[test]
    fn the_default_root_is_the_platform_one_and_the_default_home_is_inside_it() {
        let mut probe = prober(&["/data/vncode", "/data/vncode/home"]);
        let resolved = resolve_with(&inputs(), &mut probe);
        assert_eq!(resolved.app_root_path(), Some(Path::new("/data/vncode")));
        assert_eq!(resolved.home_path(), Some(Path::new("/data/vncode/home")));
        assert_eq!(resolved.home.as_ref().unwrap().origin, Origin::Owned);
        // The harness's own `~/.dsh` is never reached by the app's own choice: no
        // candidate on either ladder names it.
        assert!(resolved.refused.is_empty(), "{:?}", resolved.refused);
    }

    #[test]
    fn a_writable_inherited_home_is_joined_and_the_furniture_stays_in_the_root() {
        // The confirmed behaviour: launched from inside a harness session, the app
        // runs against that session's home and shares its sessions and key.
        let mut probe = prober(&["/data/vncode", "/parent/.dsh"]);
        let resolved = resolve_with(
            &Inputs { inherited: Some("/parent/.dsh"), ..inputs() },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/parent/.dsh")));
        assert_eq!(resolved.home.as_ref().unwrap().origin, Origin::Inherited);
        // ...and the root is still the app's own, so the geometry and the npm cache
        // do not follow the home.
        assert_eq!(resolved.app_root_path(), Some(Path::new("/data/vncode")));
    }

    #[test]
    fn an_unwritable_inherited_home_falls_through_instead_of_refusing() {
        // THE REGRESSION THIS REVISION EXISTS FOR. Before M0 this was a refusal that
        // named `~/.dsh` and told the person to start the app differently, which
        // cannot fix a parent that confines its children.
        let mut probe = prober(&["/data/vncode", "/data/vncode/home"]);
        let resolved = resolve_with(
            &Inputs { inherited: Some("/confined/.dsh"), ..inputs() },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/data/vncode/home")));
        assert!(resolved.problem().is_none(), "a refused inherited home must not stop the run");
        let notes = resolved.notes();
        assert_eq!(notes.len(), 1, "{notes:?}");
        // The refusal names the path AS IT WAS RESOLVED, which is how the panel and
        // the log draw it - built here, so this reads the same on Windows as on POSIX.
        let confined = crate::userpath::resolve("/confined/.dsh", None, None).unwrap();
        assert!(notes[0].contains(&confined.display().to_string()), "{notes:?}");
        assert!(notes[0].contains("was refused"), "{notes:?}");
    }

    #[test]
    fn the_home_this_person_chose_in_the_panel_wins_over_the_inherited_one() {
        // A remembered choice that is still writable is used, because a click in the
        // panel is a decision and an environment variable is a circumstance.
        let mut probe = prober(&["/data/vncode", "/chosen/home", "/parent/.dsh"]);
        let resolved = resolve_with(
            &Inputs {
                remembered: Some(Path::new("/chosen/home")),
                inherited: Some("/parent/.dsh"),
                ..inputs()
            },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/chosen/home")));
        assert_eq!(resolved.home.as_ref().unwrap().origin, Origin::Remembered);
    }

    #[test]
    fn a_remembered_home_that_is_gone_falls_through_with_a_line() {
        // Uninstalled, moved, or on a drive that is not plugged in: the app comes up
        // anyway, and says which home it could not use.
        let mut probe = prober(&["/data/vncode", "/data/vncode/home"]);
        let resolved = resolve_with(
            &Inputs { remembered: Some(Path::new("/gone/home")), ..inputs() },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/data/vncode/home")));
        assert_eq!(resolved.refused.len(), 1);
        assert!(resolved.refused[0].line().contains("/gone/home"));
    }

    #[test]
    fn a_typed_dshhome_beats_every_other_rung() {
        let mut probe = prober(&["/data/vncode", "/flag/.dsh", "/chosen/home", "/parent/.dsh"]);
        let resolved = resolve_with(
            &Inputs {
                flag: Some("/flag/.dsh"),
                remembered: Some(Path::new("/chosen/home")),
                inherited: Some("/parent/.dsh"),
                ..inputs()
            },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/flag/.dsh")));
        assert_eq!(resolved.home.as_ref().unwrap().origin, Origin::Flag);
    }

    #[test]
    fn an_unwritable_dshhome_refuses_and_names_the_flag() {
        // The one place an explicit instruction outranks a working default.
        let mut probe = prober(&["/data/vncode"]);
        let resolved =
            resolve_with(&Inputs { flag: Some("/locked/.dsh"), ..inputs() }, &mut probe);
        assert!(resolved.strict, "a refused -DshHome must be strict");
        assert_eq!(resolved.home_path(), None);
        let problem = resolved.problem().expect("a refusal is due");
        assert!(problem.contains("-DshHome names"), "{problem}");
        let locked = crate::userpath::resolve("/locked/.dsh", None, None).unwrap();
        assert!(problem.contains(&locked.display().to_string()), "{problem}");
        // ...and it never falls through to a home the person did not ask for.
        let owned = crate::appdata::owned_home(&crate::appdata::root_in(Path::new("/data")));
        assert!(!problem.contains(&owned.display().to_string()), "{problem}");
    }

    #[test]
    fn every_rung_is_cleaned_before_it_is_probed() {
        // A `~` is expanded the way the harness expands it, a relative path is
        // resolved against the app's own directory, and `..` is folded - so what is
        // probed, exported and recorded is one absolute, real path.
        let mut probe = prober(&["/data/vncode", "/home/someone/harness"]);
        let resolved = resolve_with(
            &Inputs { flag: Some("~/harness"), ..inputs() },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/home/someone/harness")));

        let mut probe = prober(&["/data/vncode", "/cwd/here/home"]);
        let resolved = resolve_with(
            &Inputs { flag: Some("here/./home"), ..inputs() },
            &mut probe,
        );
        assert_eq!(resolved.home_path(), Some(Path::new("/cwd/here/home")));

        let mut probe = prober(&["/data/vncode", "/cwd/home"]);
        let resolved =
            resolve_with(&Inputs { flag: Some("sub/../home"), ..inputs() }, &mut probe);
        assert_eq!(resolved.home_path(), Some(Path::new("/cwd/home")));
    }

    #[test]
    fn a_path_that_cannot_be_cleaned_is_a_refusal_with_its_reason() {
        // An empty value and a NUL are refused by name, and - for the flag the person
        // typed - that refusal ENDS the run rather than quietly using another home.
        let mut probe = prober(&["/data/vncode", "/data/vncode/home"]);
        let resolved =
            resolve_with(&Inputs { flag: Some("bad\0path"), ..inputs() }, &mut probe);
        assert!(resolved.strict);
        let problem = resolved.problem().expect("a refusal is due");
        assert!(problem.contains("NUL"), "{problem}");
        // A blank flag is simply not a rung: it falls through like any absence.
        let mut probe = prober(&["/data/vncode", "/data/vncode/home"]);
        let resolved = resolve_with(&Inputs { flag: Some("   "), ..inputs() }, &mut probe);
        assert_eq!(resolved.home_path(), Some(Path::new("/data/vncode/home")));
        assert!(!resolved.strict);
    }

    #[test]
    fn a_named_root_wins_and_the_tree_is_the_last_resort() {
        // VNCODE_HOME is the app's own override.
        let mut probe = prober(&["/named", "/named/home", "/data/vncode"]);
        let resolved = resolve_with(
            &Inputs { named_root: Some("  /named  "), ..inputs() },
            &mut probe,
        );
        assert_eq!(resolved.app_root_path(), Some(Path::new("/named")));
        assert_eq!(resolved.home_path(), Some(Path::new("/named/home")));

        // A data root this account cannot write leaves the folder beside the tree,
        // which is the one a workspace-scoped confinement always grants.
        let mut probe = prober(&["/repo/.vncode", "/repo/.vncode/home"]);
        let resolved = resolve_with(&inputs(), &mut probe);
        assert_eq!(resolved.app_root_path(), Some(Path::new("/repo/.vncode")));
        assert_eq!(resolved.home_path(), Some(Path::new("/repo/.vncode/home")));
        assert_eq!(resolved.refused.len(), 1, "{:?}", resolved.refused);
    }

    #[test]
    fn nothing_writable_anywhere_is_a_named_failure_not_a_bare_start() {
        let mut probe = prober(&[]);
        let resolved = resolve_with(&inputs(), &mut probe);
        assert_eq!(resolved.app_root_path(), None);
        assert_eq!(resolved.home_path(), None);
        assert_eq!(resolved.row().0, "unknown");
        let problem = resolved.problem().expect("a refusal is due");
        // Every candidate is named, with its own error. The paths are built the way
        // the ladder builds them, so this reads the same on Windows as on POSIX.
        let data_root = crate::appdata::root_in(Path::new("/data"));
        let tree_root = crate::appdata::tree_root(Path::new("/repo"));
        assert!(problem.contains(&data_root.display().to_string()), "{problem}");
        assert!(problem.contains(&tree_root.display().to_string()), "{problem}");
        assert!(problem.contains("access is denied"), "{problem}");
        assert!(problem.contains("Pass -DshHome"), "{problem}");
    }

    #[test]
    fn a_refused_rung_is_carried_along_when_a_later_one_wins() {
        // The panel shows what was refused, not only what was chosen: that is what
        // makes "why did it do that" answerable.
        let mut probe = prober(&["/data/vncode", "/data/vncode/home"]);
        let resolved = resolve_with(
            &Inputs { inherited: Some("/confined/.dsh"), ..inputs() },
            &mut probe,
        );
        let selection = resolved.home.as_ref().unwrap();
        assert_eq!(selection.refused.len(), 1);
        assert!(selection.refused[0].path.ends_with(".dsh"));
        assert!(selection.refused[0].line().contains("was refused"));
        // Built the way the ladder builds it, so this reads the same on Windows.
        let expected = crate::appdata::owned_home(&crate::appdata::root_in(Path::new("/data")));
        assert_eq!(selection.row().0, expected.display().to_string());
        assert!(selection.row().1.contains("this app's own home"));
    }

    #[test]
    fn whether_the_app_created_the_home_travels_with_the_decision() {
        // The panel says "I made this" or "I joined this", and only a directory this
        // app created is ever hardened.
        let mut probe = |path: &Path| {
            Ok(Probed { path: path.to_path_buf(), created: path.ends_with("home") })
        };
        let resolved = resolve_with(&inputs(), &mut probe);
        assert!(resolved.home_created(), "the app's own home is one it created");

        let mut probe = |path: &Path| {
            Ok(Probed { path: path.to_path_buf(), created: false })
        };
        let resolved = resolve_with(
            &Inputs { inherited: Some("/parent/.dsh"), ..inputs() },
            &mut probe,
        );
        assert!(!resolved.home_created(), "a joined home is not one the app created");
    }

    #[test]
    fn home_candidates_keep_the_order_and_only_the_flag_is_strict() {
        let candidates = home_candidates(&inputs(), Some(Path::new("/root")));
        let origins: Vec<Origin> = candidates.iter().map(|candidate| candidate.origin).collect();
        assert_eq!(origins, vec![Origin::Owned], "{origins:?}");
        assert_eq!(candidates[0].path, PathBuf::from("/root").join("home"));
        assert!(!candidates[0].strict);

        let all = home_candidates(
            &Inputs {
                flag: Some("/flag"),
                remembered: Some(Path::new("/chosen")),
                inherited: Some("/parent"),
                ..inputs()
            },
            Some(Path::new("/root")),
        );
        assert_eq!(all.len(), 4, "{all:?}");
        assert!(all[0].strict, "only -DshHome is strict");
        assert!(!all[1].strict && !all[2].strict && !all[3].strict);
        assert_eq!(all[1].origin, Origin::Remembered);
        assert_eq!(all[3].path, PathBuf::from("/root").join("home"));
    }

    #[test]
    fn a_home_is_recognised_by_its_shape_not_by_its_name() {
        let root = crate::scratch::dir("shape");
        std::fs::create_dir_all(&root).unwrap();
        assert!(!looks_like_a_harness_home(&root));
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        assert!(looks_like_a_harness_home(&root), "sessions/ is the shape of a harness home");
        assert!(!looks_like_a_harness_home(&root.join("nowhere")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_default_home_appends_dsh_and_is_never_the_user_home() {
        let user_home = Path::new("some-user-home");
        let resolved = default_dsh_home(user_home);
        assert_eq!(resolved.file_name().and_then(|name| name.to_str()), Some(".dsh"));
        assert_ne!(resolved, user_home, "the harness home is ~/.dsh, not ~");
    }

    #[test]
    fn windows_prefers_userprofile_because_node_does() {
        assert_eq!(
            pick_home_variable(Some("C:\\Users\\me"), Some("C:\\elsewhere"), true),
            Some("C:\\Users\\me")
        );
        assert_eq!(pick_home_variable(None, Some("C:\\elsewhere"), true), Some("C:\\elsewhere"));
    }

    #[test]
    fn unix_prefers_home() {
        assert_eq!(pick_home_variable(None, Some("/home/me"), false), Some("/home/me"));
        assert_eq!(
            pick_home_variable(Some("C:\\Users\\me"), Some("/home/me"), false),
            Some("/home/me")
        );
    }

    #[test]
    fn blank_home_variables_do_not_count() {
        assert_eq!(pick_home_variable(Some(""), None, true), None);
        assert_eq!(pick_home_variable(Some("   "), None, true), None);
        assert_eq!(pick_home_variable(None, None, false), None);
    }
}