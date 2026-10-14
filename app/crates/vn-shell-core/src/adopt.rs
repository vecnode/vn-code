//! Adopt: what this app may copy out of a home it did not create.
//!
//! The app's own home starts empty, while the user's real installation - sessions,
//! skills, the model key - is usually in the harness's default `~/.dsh`. **Adopt** is
//! the one-click answer: copy the durable, SMALL things into the home the app proved
//! it can write, and never the caches.
//!
//! Three rules, and they are the whole module:
//!
//! 1. **Nothing is written into the source.** Adopt reads from it and writes into the
//!    home it proved it can write; a source that cannot be read offers no Adopt at
//!    all (see [`Offer`]).
//! 2. **The caches are never adopted.** `docs/PATHS.md` puts ceilings on them (512
//!    MiB of PDF artifacts, 200 MiB of diagram artifacts, up to 8 GiB of playable
//!    media) and every byte of them is reproducible, so copying them would turn a
//!    one-click gesture into a multi-gigabyte one for nothing.
//! 3. **`profiles/` is never adopted either**, because the panel's own Install button
//!    re-creates it from this checkout: copying it would fight the installer.
//!
//! The credentials file is the deliberate exception to "copy the durable things",
//! and it is a separate gesture: `SECURITY.md` promises this app touches that file
//! for PRESENCE only, and a byte-for-byte copy is the only form of "copy" that keeps
//! that promise - the value is never parsed, never held in a `KeyState`, never drawn.

use std::path::{Path, PathBuf};

/// The durable, small things Adopt copies, in the order the panel lists them.
pub const DURABLE: [(&str, &str); 4] = [
    ("skills", "the skills the harness loads, including the ones this pack copies"),
    ("sessions", "one file per conversation - the durable transcript"),
    ("storages", "workspace.json and the session projection caches"),
    ("attachments", "files pasted or attached into a conversation"),
];

/// The pack's caches and the composed profile: never adopted, and the reason why.
pub const NEVER: [(&str, &str); 4] = [
    ("profiles", "re-created by the Install button, so copying it would fight the installer"),
    ("dsh-pdf", "a cache with a 512 MiB ceiling - reproducible"),
    ("dsh-diagrams", "a cache with a 200 MiB ceiling - reproducible"),
    ("dsh-media", "up to 8 GiB of provisioned binaries and playable media - reproducible"),
];

/// The harness's own credential document, inside a home.
pub const CREDENTIALS: &str = ".credentials.yaml";

/// One thing to copy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub name: &'static str,
    pub note: &'static str,
    pub from: PathBuf,
    pub to: PathBuf,
}

/// What an Adopt run would do: where from, where to, and what.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adoption {
    pub source: PathBuf,
    pub target: PathBuf,
    pub items: Vec<Item>,
}

impl Adoption {
    /// The source's own credential document, when it has one.
    ///
    /// Never part of [`Adoption::items`]: it is the second, separate click.
    pub fn credential(&self) -> Option<PathBuf> {
        let path = self.source.join(CREDENTIALS);
        path.is_file().then_some(path)
    }

    /// One line naming what will be copied, for the log.
    pub fn line(&self) -> String {
        if self.items.is_empty() {
            return format!(
                "there is nothing to adopt from {} - it has none of {}",
                self.source.display(),
                names()
            );
        }
        format!(
            "adopting {} from {} into {}",
            self.items
                .iter()
                .map(|item| item.name)
                .collect::<Vec<_>>()
                .join(", "),
            self.source.display(),
            self.target.display()
        )
    }
}

/// `skills, sessions, storages, attachments`.
fn names() -> String {
    let mut names = DURABLE.iter().map(|(name, _)| *name).collect::<Vec<_>>();
    let last = names.pop().unwrap_or_default();
    format!("{} or {}", names.join(", "), last)
}

/// Whether a home has none of YOUR things yet - the rule that decides whether the
/// panel offers Adopt at all.
///
/// "Yours" is exactly what Adopt would copy: the durable trees, and the credential
/// document. A home that already has a `sessions/` or a `.credentials.yaml` has a life
/// of its own, and copying an older installation into it is a merge nobody asked for -
/// so Adopt is for a home with nothing of yours in it.
///
/// **`profiles/` is deliberately NOT part of this test**, and that is a bug this rule
/// had: the harness composes `profiles/<name>/` into the home on its VERY FIRST boot,
/// so a home the app created stopped looking "untouched" after one run - and the one
/// thing a person most wants to bring across (their key, their sessions) could never be
/// offered again. Adopt does not copy `profiles/` anyway; the installer re-creates it.
pub fn target_is_untouched(target: &Path) -> bool {
    DURABLE.iter().all(|(name, _)| !target.join(name).exists())
        && !target.join(CREDENTIALS).exists()
}

/// Whether the source can be read at all. A source that cannot is not adopted
/// quietly: the panel says so and offers nothing.
pub fn source_is_readable(source: &Path) -> bool {
    std::fs::read_dir(source).is_ok()
}

/// What the panel should offer, decided from two paths and the filesystem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Offer {
    /// Nothing to offer: the ordinary first run with no other home on the machine.
    Nothing,
    /// Adopt is available, with this list.
    Available(Adoption),
    /// There IS another home, and it cannot be read - which the panel says out loud
    /// rather than showing a button that would fail.
    Unreadable(PathBuf),
}

/// Decide the offer from the source (usually `~/.dsh`) and the chosen home.
pub fn offer(source: Option<&Path>, home: Option<&Path>) -> Offer {
    let (Some(source), Some(home)) = (source, home) else {
        return Offer::Nothing;
    };
    if !source.is_dir() {
        return Offer::Nothing;
    }
    if !target_is_untouched(home) {
        return Offer::Nothing;
    }
    if !source_is_readable(source) {
        return Offer::Unreadable(source.to_path_buf());
    }
    let adoption = plan(source, home);
    if adoption.items.is_empty() {
        Offer::Nothing
    } else {
        Offer::Available(adoption)
    }
}

/// Build the list of things to copy: the durable trees the source actually has.
pub fn plan(source: &Path, target: &Path) -> Adoption {
    let mut items = Vec::new();
    for (name, note) in DURABLE {
        let from = source.join(name);
        if !from.exists() {
            continue;
        }
        items.push(Item {
            name,
            note,
            from: from.clone(),
            to: target.join(name),
        });
    }
    Adoption { source: source.to_path_buf(), target: target.to_path_buf(), items }
}

/// The bytes a directory tree holds, walking at most `budget` entries.
///
/// The same bounded walk the location map uses, for the same reason: a cache with a
/// million tiny files must not freeze the window while the panel asks how big it is.
/// `None` means "nothing there"; the caller shows a `+` when the budget was reached.
pub fn size_of(root: &Path, budget: usize) -> Option<(u64, bool)> {
    if !root.exists() {
        return None;
    }
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut capped = false;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > budget {
                capped = true;
                break;
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
        if capped {
            break;
        }
    }
    Some((total, capped))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-adopt-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn only_the_durable_small_things_are_planned_and_only_what_exists() {
        let root = scratch("plan");
        let source = root.join(".dsh");
        let target = root.join("home");
        for name in ["skills", "sessions", "dsh-media", "dsh-pdf"] {
            std::fs::create_dir_all(source.join(name)).unwrap();
        }
        std::fs::create_dir_all(&target).unwrap();
        let adoption = plan(&source, &target);
        let names: Vec<&str> = adoption.items.iter().map(|item| item.name).collect();
        assert_eq!(names, vec!["skills", "sessions"], "{names:?}");
        // The caches are NOT planned, and neither is the composed profile.
        for never in ["dsh-media", "dsh-pdf", "profiles"] {
            assert!(!names.contains(&never), "{never} was planned for adoption");
        }
        assert!(adoption.line().contains("skills, sessions"), "{}", adoption.line());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_credentials_file_is_not_an_item_and_is_offered_separately() {
        let root = scratch("credentials");
        let source = root.join(".dsh");
        std::fs::create_dir_all(source.join("skills")).unwrap();
        std::fs::write(source.join(CREDENTIALS), b"deepseek: {apiKey: placeholder}\n").unwrap();
        let adoption = plan(&source, &root.join("home"));
        assert!(adoption.items.iter().all(|item| item.name != CREDENTIALS));
        assert_eq!(adoption.credential(), Some(source.join(CREDENTIALS)));
        // ...and a home with no credentials file offers none.
        let bare = scratch("bare");
        std::fs::create_dir_all(bare.join(".dsh").join("skills")).unwrap();
        assert_eq!(plan(&bare.join(".dsh"), &bare.join("home")).credential(), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn adopt_is_offered_only_for_a_home_with_nothing_of_yours_in_it() {
        let root = scratch("offer");
        let source = root.join(".dsh");
        std::fs::create_dir_all(source.join("sessions")).unwrap();
        let fresh = root.join("home");
        std::fs::create_dir_all(&fresh).unwrap();

        assert!(matches!(offer(Some(&source), Some(&fresh)), Offer::Available(_)));

        // A home the harness has already booted in is STILL offered: it composes
        // `profiles/` by itself on the first boot, so counting that as "used" is how
        // a person's key and sessions stopped being offered at all. Measured against a
        // real run's log, where the home was `<tree>/.vncode/home` with `profiles/web`
        // in it and the key was still in `~/.dsh`.
        std::fs::create_dir_all(fresh.join("profiles").join("web")).unwrap();
        assert!(
            matches!(offer(Some(&source), Some(&fresh)), Offer::Available(_)),
            "a composed profile must not close the offer"
        );

        // A home with sessions of its own, or with a credentials file, is not adopted
        // over: it has a life of its own.
        std::fs::create_dir_all(fresh.join("sessions")).unwrap();
        assert_eq!(offer(Some(&source), Some(&fresh)), Offer::Nothing);
        std::fs::remove_dir_all(fresh.join("sessions")).unwrap();
        std::fs::write(fresh.join(CREDENTIALS), b"deepseek: {}\n").unwrap();
        assert_eq!(offer(Some(&source), Some(&fresh)), Offer::Nothing);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_source_that_cannot_be_read_offers_nothing_and_says_so() {
        let root = scratch("unreadable");
        // A FILE where a home should be: it exists, so Adopt is considered, and it is
        // not a directory, so there is nothing to adopt and nothing to promise.
        let not_a_home = root.join(".dsh");
        std::fs::write(&not_a_home, b"not a directory").unwrap();
        let target = root.join("home");
        std::fs::create_dir_all(&target).unwrap();
        assert_eq!(offer(Some(&not_a_home), Some(&target)), Offer::Nothing);
        // No source at all (a first run on a clean machine) is also nothing.
        assert_eq!(offer(None, Some(&target)), Offer::Nothing);
        assert_eq!(offer(Some(&root.join("absent")), Some(&target)), Offer::Nothing);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_home_with_none_of_the_durable_trees_has_nothing_to_offer() {
        let root = scratch("empty-source");
        let source = root.join(".dsh");
        std::fs::create_dir_all(source.join("cache")).unwrap();
        let target = root.join("home");
        std::fs::create_dir_all(&target).unwrap();
        assert_eq!(offer(Some(&source), Some(&target)), Offer::Nothing);
        assert!(plan(&source, &target).line().contains("nothing to adopt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_size_walk_is_bounded_and_says_when_it_stopped() {
        let root = scratch("size");
        let tree = root.join("sessions");
        std::fs::create_dir_all(&tree).unwrap();
        for index in 0..8 {
            std::fs::write(tree.join(format!("s{index}.json")), b"0123456789").unwrap();
        }
        let (bytes, capped) = size_of(&tree, 100).unwrap();
        assert_eq!(bytes, 80);
        assert!(!capped);
        // A budget smaller than the tree reports the cap rather than a wrong total.
        let (_, capped) = size_of(&tree, 3).unwrap();
        assert!(capped, "the walk did not report that it stopped early");
        assert_eq!(size_of(&root.join("absent"), 100), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
