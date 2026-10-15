//! Where THIS application keeps its own data, and where the harness home lives.
//!
//! Since M0 the app owns a root — `$VNCODE_HOME` — and the harness home is a
//! directory *inside* it:
//!
//! ```text
//! $VNCODE_HOME                     the app's root: furniture the app owns
//!   ├── window.json                the geometry record
//!   ├── prefs.json                 the browser and the home this person chose
//!   ├── npm-cache/                 the npx fallback's cache
//!   └── home/                      DSH_HOME by default: everything that matters
//!       ├── profiles/  sessions/  storages/  attachments/  skills/
//!       └── .credentials.yaml
//! ```
//!
//! ## One root, and the portable one
//!
//! Everything the app owns lives under ONE root - the geometry, `prefs.json`, the npm
//! cache and the home - so a folder can be picked up and moved, and so a root the app
//! could not write (a confined run, a read-only mount) never splits the app's memory
//! in two. `<tree>/.vncode` is that root when the folder is a **portable
//! installation**: it carries the marker, or it already holds a home (see
//! [`portable_root`]). A folder that is neither uses the platform's own data root,
//! and the app's own home inside it.
//!
//! The furniture sits outside the home because the app must not write its own
//! records into a home it did not create, and because `-DshHome` may point at a
//! folder shared with `scripts\run-web.bat`. `home.rs` owns the order and the proof;
//! this module answers "where does this platform put per-user data", "what is inside
//! a root", and "can this account actually write there".
//!
//! ## Why the npm cache is not the machine's shared one
//!
//! `npx` writes to `%LOCALAPPDATA%\npm-cache` by default, and that directory is a
//! shared, machine-wide resource that other tooling - and an ELEVATED run of
//! anything, this shell included - also writes to. Measured on the machine this was
//! written on: after one run "as Administrator", twelve files inside that cache
//! were owned by `BUILTIN\Administrators` rather than the signed-in user, and the
//! next ordinary (non-elevated) run failed with
//!
//! ```text
//! npm error code EPERM
//! npm error path ...\npm-cache\_cacache\tmp\7493d7c0
//! npm error Log files were not written due to an error writing to the
//! directory: ...\npm-cache\_logs
//! ```
//!
//! which is a permission failure the reader is told to fix by running as
//! Administrator - the wrong lesson twice over: this shell never needs elevation,
//! and taking that advice makes the problem worse by writing MORE files as the
//! elevated account.
//!
//! Pointing the cache at this application's own directory removes the shared
//! resource from the equation: the bytes are written under the application's own
//! root, by the account actually running it, and a cache left behind by an elevated
//! run elsewhere cannot poison an ordinary one. It also keeps the cache prunable
//! with the rest of the application's data.
//!
//! This is also half of the reason the VENDORED runtime is preferred at launch
//! (see `launch`): a vendored runtime reads no cache at all, so on that path npm is
//! not merely redirected, it is never started.
//!
//! ## It is not `$DSH_HOME`
//!
//! The OS's own per-user data directory, deliberately: this is the application's
//! own state, not the harness's, and it must survive a `-DshHome` that points
//! somewhere unusual - and a run with no `DSH_HOME` at all, where the harness
//! applies its own default and this shell has nothing to do with it.

use std::path::{Path, PathBuf};

/// The per-user data root for this application on this platform.
pub fn data_root() -> Option<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var("LOCALAPPDATA").ok().filter(|value| !value.trim().is_empty());
        return local.map(PathBuf::from).or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|home| PathBuf::from(home).join("AppData").join("Local"))
        });
    }
    if cfg!(target_os = "macos") {
        return std::env::var("HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    }
    std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|home| PathBuf::from(home).join(".local").join("share"))
        })
}

/// The per-OS npm cache ROOT - where `npx` unpacks the packages it runs.
///
/// Not the same thing as [`npm_cache_dir`], which is the cache this shell makes npm
/// use. This one is the machine's own, and it is read for one reason: the harness
/// ALREADY installed there can be run without npm at all (see
/// `launch::installed_harness`).
pub fn npx_cache_root() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("npm-cache"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".npm"))
    }
}

/// This application's root under a platform data root: `<data root>/vncode`.
pub fn root_in(data_root: &std::path::Path) -> PathBuf {
    data_root.join("vncode")
}

/// The app's root, first match winning: `VNCODE_HOME`, then the platform's own
/// per-user data root.
///
/// This is ONE CANDIDATE, not the decision: `home::root_candidates` walks the whole
/// ladder (`VNCODE_HOME`, a portable folder's own root, this, then the folder beside
/// the tree) and probes each rung by writing. What this function is still the answer
/// to is "where is the record that outlives every root" - the platform copy of
/// `prefs.json` is read as a fallback when the ladder's own root has none, and that is
/// the only reason it is asked before the ladder runs.
///
/// `None` means neither is available. `home.rs` answers that with the tree-adjacent
/// candidate and then a named failure - never with a guess.
pub fn app_root_with(named: Option<&str>, data_root: Option<&std::path::Path>) -> Option<PathBuf> {
    if let Some(named) = named {
        let named = named.trim();
        if !named.is_empty() {
            return Some(PathBuf::from(named));
        }
    }
    data_root.map(root_in)
}

/// [`app_root_with`] against this process's own environment.
pub fn app_root() -> Option<PathBuf> {
    app_root_with(std::env::var("VNCODE_HOME").ok().as_deref(), data_root().as_deref())
}

/// The root beside the tree: `<tree>/.vncode`.
///
/// The last root candidate, and the only one a workspace-scoped confinement (this
/// repository's own checks run inside one) always grants. `.gitignore` carries the
/// rule that keeps it out of a commit.
pub fn tree_root(tree: &std::path::Path) -> PathBuf {
    tree.join(".vncode")
}

/// The harness home inside a root: `<root>/home`.
pub fn owned_home(app_root: &std::path::Path) -> PathBuf {
    app_root.join("home")
}

/// The marker a person (or this app's own button) leaves to say **keep everything
/// in this folder**: `<tree>/.vncode/PORTABLE`.
///
/// It is a FILE, not the folder, because the folder is created by anything that
/// falls back to it - including a confined run, which is exactly the case where a
/// last-resort root must not quietly become a policy. The marker is a decision.
pub const PORTABLE_MARKER: &str = "PORTABLE";

/// The portable marker inside a tree's own root: `<tree>/.vncode/PORTABLE`.
pub fn portable_marker(tree: &std::path::Path) -> PathBuf {
    tree_root(tree).join(PORTABLE_MARKER)
}

/// **The tree's own root, when this folder is a portable installation.**
///
/// Two facts make it one, and the first is what makes a folder "remembered next
/// time" without anybody pressing anything:
///
/// * the marker is there (`<tree>/.vncode/PORTABLE`) - the explicit choice, written by
///   the panel's own button; or
/// * the folder already holds a home (`<tree>/.vncode/home`) - the app has ALREADY put
///   this person's sessions, skills and profile there, so preferring the platform's
///   data directory now would silently start a second installation beside it. That is
///   the measured state of a machine whose app root fell through to the tree under a
///   confinement: the next ordinary double-click must use that home, not a new one.
///
/// Read only: nothing here creates the folder or the marker. `mark_portable` does
/// that, and only on a click.
pub fn portable_root(tree: &std::path::Path) -> Option<PathBuf> {
    let root = tree_root(tree);
    if portable_marker(tree).is_file() || owned_home(&root).is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Make this folder a portable installation: create its root and write the marker.
///
/// Returns the root that the NEXT start will use. The running app cannot move its own
/// root (the home, the geometry and the preferences all live in it), which is why the
/// panel says "restart" rather than pretending the click took effect now.
pub fn mark_portable(tree: &std::path::Path) -> Result<PathBuf, String> {
    let root = tree_root(tree);
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("could not create {}: {error}", root.display()))?;
    let marker = portable_marker(tree);
    std::fs::write(&marker, b"portable\n")
        .map_err(|error| format!("could not write {}: {error}", marker.display()))?;
    Ok(root)
}

/// A scratch directory this application owns, under its own root: `<root>/tmp`.
///
/// Used only when the machine's own temp is not writable by a CHILD of this app -
/// measured, from a log of a real run: the harness's `dsh-spill-local` row died with
/// `EPERM: operation not permitted, mkdtemp 'C:\Users\…\AppData\Local\Temp\dsh-spill-XXXXXX'`
/// and the entry that owned it did not activate. The child had inherited `TEMP`, and
/// the confinement that grants this app its own root does not necessarily grant
/// `%TEMP%` to a process under it.
pub fn owned_temp(app_root: &std::path::Path) -> PathBuf {
    app_root.join("tmp")
}

/// The machine's own temp directory, as the CHILD would inherit it.
///
/// `TMPDIR` first (Node's `os.tmpdir()` on POSIX), then `TMP`, then `TEMP` - the same
/// order Node uses, because the child is a Node program and that is the variable it
/// will read.
pub fn machine_temp() -> Option<PathBuf> {
    for name in ["TMPDIR", "TMP", "TEMP"] {
        if let Some(value) = std::env::var_os(name) {
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// The npm cache this application owns, under its own root.
///
/// `<app root>/npm-cache` - `%LOCALAPPDATA%\vncode\npm-cache` by default, the
/// directory the EPERM bug below moved it to. It follows `VNCODE_HOME`, because it
/// is the app's furniture, and it does NOT follow `-DshHome`.
pub fn npm_cache_dir(app_root: &std::path::Path) -> PathBuf {
    app_root.join("npm-cache")
}

/// What a probe found, and whether it had to create the directory to find it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probed {
    /// The path, in its real form ([`crate::userpath::canonical`]).
    pub path: PathBuf,
    /// Whether THIS probe created the directory. Only a directory this app created
    /// is ever hardened - see [`harden_if_created`].
    pub created: bool,
}

/// Whether this application can actually WRITE in a directory, right now - and the
/// error when it cannot.
///
/// The probe is the operation itself: create the directory, write a file, remove it.
/// A permission bit is not the question and neither is `exists()`; the failures this
/// answers are `EPERM` from npm inside a directory that exists and looks like ours,
/// a read-only mount, and a parent process that confines what its children may write.
///
/// The path it returns is the REAL one (`userpath::canonical`), because that is what
/// gets exported to the harness and recorded in the panel: two spellings of one home
/// must not look like two homes, and the Windows verbatim form must never reach a
/// child.
pub fn probe(directory: &Path) -> Result<Probed, String> {
    let created = !directory.exists();
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("{} could not be created: {error}", directory.display()))?;
    let probe = directory.join(format!(".vncode-write-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
        }
        Err(error) => return Err(format!("{} is not writable: {error}", directory.display())),
    }
    let path = crate::userpath::canonical(directory);
    harden_if_created(&path, created);
    Ok(Probed { path, created })
}

/// Tighten a directory this app CREATED, and only one it created.
///
/// On Unix the harness home is set to `0700`, because it holds `.credentials.yaml`
/// (the harness itself refuses to boot if that file is group- or other-readable) and
/// the app root holds an npm cache, which can hold registry credentials. The default
/// `0755 & !umask` is a wider door than either needs.
///
/// Two deliberate limits:
///
/// * **A directory this app JOINED is never touched.** Tightening `~/.dsh` because
///   somebody pointed the app at it would be editing a directory that has an owner,
///   a history and possibly other tools inside it. `created` is what keeps that
///   honest, and it is why the probe reports it.
/// * **On Windows this does nothing.** The directories the app creates live under
///   the user's own profile and inherit its ACL; rewriting ACLs would need rights
///   this pack refuses to ask for, and a half-set ACL is worse than an inherited one.
pub fn harden_if_created(path: &Path, created: bool) {
    if !created {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// [`probe`] as a boolean, for callers that only need the answer.
pub fn is_writable(directory: &Path) -> bool {
    probe(directory).is_ok()
}

/// Whether the harness home can be written in - asked of the home ITSELF.
///
/// It used to be asked of `<home>/vncode`, because that is where this app kept its
/// own file inside a home it did not own. It keeps nothing there any more (the
/// furniture lives under `$VNCODE_HOME`), and probing a subdirectory would CREATE a
/// directory inside a home that is about to be refused - a side effect on somebody
/// else's tree. So the probe writes one transient file at the home's own root and
/// removes it, and a refused candidate is left exactly as it was found.
///
/// This is the check that turns "Start, then wait three minutes for a ready line that
/// cannot come" into one instant sentence. The harness composes its profile into
/// `<home>/profiles/<profile>/` on every boot, so a home this account cannot write in
/// means the harness CANNOT start - whatever the reason: an ACL an elevated run left
/// behind, a read-only mount, or a parent process that confines what its children may
/// write.
pub fn harness_home_is_writable(home: &std::path::Path) -> bool {
    probe(home).is_ok()
}

/// Whether a cache directory is one npm can actually use.
///
/// NOT the cache root, and this is the whole reason the function exists. npm writes
/// every payload into `<cache>/_cacache/tmp/<hash>` and then moves it into place, so
/// a cache whose ROOT is writable while its `_cacache` tree belongs to somebody else
/// fails exactly the way this was reported:
///
/// ```text
/// npm error code EPERM
/// npm error path C:\...\vncode\npm-cache\_cacache\tmp\a7c995e4
/// ```
///
/// ...while a probe that writes a file at the root - which is what the first
/// version of this check did - cheerfully says the cache is fine. The probe
/// therefore creates and writes in the directory npm really writes in.
pub fn npm_cache_is_usable(cache: &std::path::Path) -> bool {
    is_writable(&cache.join("_cacache").join("tmp"))
}

/// Where npm's cache should go, and why that is not the first choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheChoice {
    pub path: PathBuf,
    /// A line worth printing when an earlier choice had to be refused.
    pub warning: Option<String>,
}

/// Choose a cache npm can really write its payloads into, preferring the
/// application's own directory.
///
/// `npx` writes its cache wherever `npm_config_cache` points, so a directory the
/// account cannot write in is not a cosmetic problem: npm fails the whole install
/// with `EPERM` and then advises running as Administrator - which is the advice that
/// CREATED the unwritable directory in the first place.
///
/// A candidate npm could not write in is REFUSED and the next is used, with a line
/// saying so. A run that quietly moved the cache would leave the next reader looking
/// at the wrong directory.
pub fn choose_npm_cache(candidates: &[PathBuf]) -> Option<CacheChoice> {
    let mut warning = None;
    for (index, candidate) in candidates.iter().enumerate() {
        if npm_cache_is_usable(candidate) {
            return Some(CacheChoice { path: candidate.clone(), warning });
        }
        if index == 0 {
            // A NOTE, not a log line: the caller prefixes its own. A second
            // `[vncode] note:` inside it reads as a bug in the transcript.
            warning = Some(format!(
                "{} is NOT usable by this account, so npm's cache is going somewhere else - an elevated run probably created that directory, and npm's own advice to 'run as Administrator' is what does it",
                candidate.display()
            ));
        }
    }
    None
}

/// The cache candidates in order, from the facts a launch has.
///
/// 1. the app's own root (`$VNCODE_HOME/npm-cache`, `%LOCALAPPDATA%\vncode\npm-cache`
///    by default) - where it belongs, and shared with nobody;
/// 2. the harness home (`$DSH_HOME/vncode/npm-cache`) - normally writable even when
///    the first is broken, because the harness itself writes there;
/// 3. beside the vendored runtime, inside the checkout.
pub fn npm_cache_candidates(
    app_root: Option<&std::path::Path>,
    harness_home: Option<&std::path::Path>,
    repo_root: Option<&std::path::Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = app_root {
        candidates.push(npm_cache_dir(root));
    }
    if let Some(home) = harness_home {
        candidates.push(home.join("vncode").join("npm-cache"));
    }
    if let Some(repo) = repo_root {
        candidates.push(repo.join("runtime").join("npm-cache"));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-appdata-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn the_root_holds_the_home_and_the_cache_beside_each_other() {
        // The shape this revision introduced: one root the app owns, the harness home
        // a directory inside it, and the cache beside the home rather than inside it -
        // so the cache survives a `-DshHome` that points at somebody else's folder.
        let root = root_in(std::path::Path::new("/data"));
        assert_eq!(root, PathBuf::from("/data").join("vncode"));
        assert_eq!(owned_home(&root), PathBuf::from("/data").join("vncode").join("home"));
        assert_eq!(
            npm_cache_dir(&root),
            PathBuf::from("/data").join("vncode").join("npm-cache")
        );
        assert!(
            !npm_cache_dir(&root).starts_with(owned_home(&root)),
            "the app's cache must not live inside the harness home"
        );
    }

    #[test]
    fn a_named_vncode_home_wins_over_the_platform_root() {
        // `VNCODE_HOME` is the app's own override; it is read through this one
        // function, and the pure half is what is pinned here so the test cannot race
        // another test over the process environment.
        assert_eq!(
            app_root_with(Some("  /tmp/a-named-root  "), Some(std::path::Path::new("/data"))),
            Some(PathBuf::from("/tmp/a-named-root"))
        );
        assert_eq!(
            app_root_with(Some("   "), Some(std::path::Path::new("/data"))),
            Some(PathBuf::from("/data").join("vncode")),
            "a blank name is not a name, so the platform default stands"
        );
        assert_eq!(app_root_with(None, None), None);
    }

    #[test]
    fn the_tree_candidate_is_the_dot_vncode_folder() {
        assert_eq!(
            tree_root(std::path::Path::new("/repo")),
            PathBuf::from("/repo").join(".vncode")
        );
    }

    #[test]
    fn a_folder_is_portable_by_the_marker_or_by_the_home_it_already_holds() {
        let tree = scratch("portable");
        std::fs::create_dir_all(&tree).unwrap();
        // A fresh checkout is NOT portable: nothing has chosen the folder yet.
        assert_eq!(portable_root(&tree), None);
        // ...the marker is the explicit choice.
        let root = mark_portable(&tree).unwrap();
        assert_eq!(root, tree.join(".vncode"));
        assert!(portable_marker(&tree).is_file());
        assert_eq!(portable_root(&tree), Some(root.clone()));

        // ...and a home already inside the root is the same answer without a marker,
        // because the app has already put this person's state there.
        let other = scratch("portable-home-only");
        std::fs::create_dir_all(owned_home(&tree_root(&other))).unwrap();
        assert_eq!(portable_root(&other), Some(tree_root(&other)));
        assert!(!portable_marker(&other).exists(), "reading must not write the marker");

        let _ = std::fs::remove_dir_all(&tree);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn marking_a_folder_portable_creates_the_root_and_reports_a_refusal() {
        let tree = scratch("mark");
        std::fs::create_dir_all(&tree).unwrap();
        assert!(mark_portable(&tree).is_ok());
        // A tree that cannot hold a folder - its own path is a FILE - is refused with
        // the path in the sentence rather than silently doing nothing.
        let blocker = tree.join("a-file");
        std::fs::write(&blocker, b"x").unwrap();
        let error = mark_portable(&blocker).unwrap_err();
        assert!(error.contains("could not create"), "{error}");
        let _ = std::fs::remove_dir_all(&tree);
    }

    #[test]
    fn writability_is_probed_by_writing() {
        let root = scratch("writable");
        assert!(is_writable(&root), "a fresh scratch directory must be writable");
        // ...and the probe cleans up after itself.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        // A path whose PARENT is a file can never be created on any platform - the
        // portable stand-in for "this account may not write here".
        let blocker = root.join("blocker");
        std::fs::write(&blocker, b"a file, not a directory").unwrap();
        assert!(!is_writable(&blocker.join("under-a-file")));
        // ...and the refusal carries the reason the panel prints.
        let reason = probe(&blocker.join("under-a-file")).unwrap_err();
        assert!(reason.contains("could not be created"), "{reason}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_home_probe_leaves_a_refused_home_exactly_as_it_was_found() {
        // The probe used to ask about `<home>/vncode`, which CREATED an empty folder
        // inside a home it was about to refuse - somebody else's tree. It now asks
        // about the home itself, so nothing new appears.
        let root = scratch("refused-home");
        let home = root.join("somebody-elses-home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(harness_home_is_writable(&home), "the home root itself is writable");
        assert!(!home.join("vncode").exists(), "the probe created a folder in the home");
        assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_broken_first_choice_moves_the_cache_and_says_so() {
        // The failure this exists for: `%LOCALAPPDATA%\vncode\npm-cache` owned by an
        // elevated run, and npm dying with EPERM. The app must not die with it - and
        // must not move the cache quietly either.
        let root = scratch("choose");
        std::fs::create_dir_all(&root).unwrap();
        let blocker = root.join("blocker");
        std::fs::write(&blocker, b"file").unwrap();
        let refused = blocker.join("npm-cache");
        let works = root.join("home").join("vncode").join("npm-cache");
        let choice = choose_npm_cache(&[refused.clone(), works.clone()]).expect("a fallback exists");
        assert_eq!(choice.path, works);
        let warning = choice.warning.expect("the refusal must be reported");
        assert!(warning.contains("NOT usable"), "{warning}");
        assert!(warning.contains(&refused.display().to_string()), "{warning}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cache_whose_cacache_tree_is_unwritable_is_refused() {
        // THE REPORTED FAILURE, reproduced without needing an elevated account: the
        // cache ROOT is perfectly writable, and npm still cannot write, because it
        // writes into `_cacache/tmp`. A probe at the root - the first version of
        // this check - passed here and let npm fail anyway.
        let root = scratch("cacache");
        let broken = root.join("app").join("npm-cache");
        std::fs::create_dir_all(&broken).unwrap();
        assert!(is_writable(&broken), "the cache ROOT is writable, as the report showed");
        // ...but `_cacache` is a file, so nothing under it can be created.
        std::fs::write(broken.join("_cacache"), b"not a directory").unwrap();
        assert!(!npm_cache_is_usable(&broken), "the probe must look where npm writes");
        let fresh = root.join("home").join("npm-cache");
        let choice = choose_npm_cache(&[broken, fresh.clone()]).expect("a fallback exists");
        assert_eq!(choice.path, fresh);
        assert!(choice.warning.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_first_writable_choice_wins_and_carries_no_warning() {
        let root = scratch("first-wins");
        let first = root.join("app").join("vncode").join("npm-cache");
        let second = root.join("home").join("vncode").join("npm-cache");
        let choice = choose_npm_cache(&[first.clone(), second]).expect("the first is writable");
        assert_eq!(choice.path, first);
        assert_eq!(choice.warning, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_candidate_at_all_is_an_answer_rather_than_a_panic() {
        assert_eq!(choose_npm_cache(&[]), None);
        assert!(npm_cache_candidates(None, None, None).is_empty());
        let all = npm_cache_candidates(
            Some(std::path::Path::new("/d")),
            Some(std::path::Path::new("/h")),
            Some(std::path::Path::new("/r")),
        );
        assert_eq!(all.len(), 3);
        // Order matters: the app's own root, then the harness home, then the tree.
        assert_eq!(all[0], PathBuf::from("/d").join("npm-cache"));
        assert!(all[1].starts_with("/h"));
        assert!(all[2].starts_with("/r"), "the checkout's own runtime/npm-cache");
    }

    #[test]
    fn the_root_is_whatever_this_platform_names_and_nothing_invented() {
        // On a host with the variable set, the answer is that path; with none of
        // them set the answer is `None` rather than a guess - and the caller (the
        // npx fallback) then simply leaves npm's own default alone.
        let root = data_root();
        if cfg!(windows) {
            let expected = std::env::var("LOCALAPPDATA").ok().filter(|v| !v.trim().is_empty());
            assert_eq!(root.is_some(), expected.is_some());
        }
        if let Some(root) = root {
            assert!(!root.as_os_str().is_empty());
        }
    }
}
