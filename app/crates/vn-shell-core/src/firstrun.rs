//! The first-run choice: **where your sessions, skills and key live**, made once, in
//! one place, before anything else happens.
//!
//! This module is the whole of that decision. It surveys what this machine already has,
//! turns it into the cards the panel draws, and says what each card would DO - so the
//! window is a two-button screen rather than a table of fifteen rows, and so the
//! decision itself is a `cargo test` case rather than a reading of the drawing code.
//!
//! Three answers, and they are the three a person actually has:
//!
//! | card | what it is for |
//! |---|---|
//! | **use the home already on this machine** | the harness's own default (`~/.dsh`) with `run-web`'s pack, sessions and key in it - shared, not copied |
//! | **copy it here and use the copy** | the same things, brought into this app's own root. **The way through when the existing home cannot be written** - measured: a confinement that refuses `%LOCALAPPDATA%` refuses `~/.dsh` with it, and a copy only has to READ the source |
//! | **make a fresh home here** | empty and private to this app; the pack is installed into it next |
//!
//! Nothing here decides on its own: [`Where::cards`] says what is possible and what each
//! choice means, and the person picks. The one thing the app does recommend is using a
//! home that is already there and already has the pack in it, because the alternative is
//! a second, empty harness - which is exactly the state that was measured and reported as
//! "still does not run normally".

use std::path::{Path, PathBuf};

use crate::adopt;
use crate::profile;

/// What this machine already has, told as facts a card can be trusted to print.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Existing {
    pub path: PathBuf,
    /// A child of this app can write there, proved by a probe. Without it the home
    /// cannot be USED in place - the harness composes its profile into a home on every
    /// boot - but it can still be READ, which is all a copy needs.
    pub writable: bool,
    /// Its directory can be listed, which is what a copy needs.
    pub readable: bool,
    /// How many bundles its `web` profile lists, and whether this pack is among them.
    pub bundles: usize,
    pub has_pack: bool,
    /// Session transcripts with content, and whether a credentials file with content is
    /// there. Both by COUNT and SIZE - never by reading a value.
    pub sessions: usize,
    pub key: bool,
}

/// Everything the first-run screen needs, and no more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Where {
    /// The harness's own default home, when it is a harness home at all.
    pub existing: Option<Existing>,
    /// This app's own home: `<app root>/home`.
    pub project: PathBuf,
    pub app_root: PathBuf,
}

/// Which card was picked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Use the home already on this machine, in place.
    UseExisting,
    /// Copy what is durable out of it, here, and use the copy.
    CopyExisting,
    /// Make a fresh, empty home here.
    CreateHere,
}

/// One card, ready to draw: what it would do, whether it can, and why not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub kind: Kind,
    /// The path this card would end up using.
    pub path: PathBuf,
    pub title: String,
    /// The facts, already worded: what is there now, or what would be there.
    pub facts: Vec<String>,
    pub available: bool,
    /// Why not, in one sentence, when it cannot be offered.
    pub unavailable: Option<String>,
    /// The one the app would suggest, without deciding anything.
    pub recommended: bool,
}

/// The choice, ready to apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Choice {
    pub kind: Kind,
    /// Only meaningful for [`Kind::CopyExisting`]: take the credentials file too.
    pub include_key: bool,
}

impl Choice {
    pub fn new(kind: Kind) -> Self {
        Choice { kind, include_key: false }
    }

    /// The home this choice puts in use.
    pub fn home(&self, place: &Where) -> PathBuf {
        match self.kind {
            Kind::UseExisting => place
                .existing
                .as_ref()
                .map(|existing| existing.path.clone())
                .unwrap_or_else(|| place.project.clone()),
            Kind::CopyExisting | Kind::CreateHere => place.project.clone(),
        }
    }
}

impl Where {
    /// Survey this machine. `default_home` is the harness's own default (`~/.dsh`), and
    /// `app_root` is this app's root; `project` is `<app_root>/home`.
    ///
    /// Reads only. The writability of the existing home IS probed, because that is the
    /// difference between the first card and the second, and a card that promises "use
    /// this one" over a home the harness cannot compose into would be a lie.
    pub fn survey(default_home: Option<&Path>, app_root: &Path) -> Where {
        let existing = default_home
            .filter(|path| crate::home::looks_like_a_harness_home(path))
            .map(|path| Existing {
                path: path.to_path_buf(),
                writable: crate::appdata::harness_home_is_writable(path),
                readable: adopt::source_is_readable(path),
                bundles: profile::bundles(path, crate::launch::PROFILE)
                    .map(|bundles| bundles.len())
                    .unwrap_or(0),
                has_pack: profile::bundles(path, crate::launch::PROFILE)
                    .map(|bundles| profile::has_pack(&bundles))
                    .unwrap_or(false),
                sessions: count_files(&path.join("sessions")),
                key: credentials_hold_something(&path.join(".credentials.yaml")),
            });
        Where {
            existing,
            project: crate::appdata::owned_home(app_root),
            app_root: app_root.to_path_buf(),
        }
    }

    /// The cards, in the order they are drawn.
    ///
    /// The existing-installation cards appear **only when there is one**: a card that
    /// says "no home found" teaches nothing and is exactly the clutter this screen
    /// exists to remove.
    pub fn cards(&self) -> Vec<Card> {
        let mut cards = Vec::new();
        if let Some(existing) = self.existing.as_ref() {
            let facts = describe(existing);
            // A home that can be written is the one to suggest, whether or not the pack
            // is in it yet: a home already there holds the sessions and the key, and the
            // installer adds the pack to it in place. A home that CANNOT be written
            // recommends the copy instead - that is the way through, not a consolation
            // prize.
            let recommended = existing.writable;
            cards.push(Card {
                kind: Kind::UseExisting,
                path: existing.path.clone(),
                title: "Use the DeepSeek home already on this machine".to_string(),
                facts: facts.clone(),
                available: existing.writable,
                unavailable: (!existing.writable).then(|| {
                    format!(
                        "{} cannot be written from this context, and the harness composes its profile into a home every time it starts - use the copy below, or start the app directly (double-click run-desktop.bat)",
                        existing.path.display()
                    )
                }),
                recommended,
            });
            cards.push(Card {
                kind: Kind::CopyExisting,
                path: self.project.clone(),
                title: "Copy it here, and use the copy".to_string(),
                facts: {
                    let mut facts = vec![format!("copies into {}", self.project.display())];
                    facts.extend(facts_brought(existing));
                    facts
                },
                available: existing.readable,
                unavailable: (!existing.readable).then(|| {
                    format!(
                        "{} exists but cannot be read, so nothing can be copied out of it",
                        existing.path.display()
                    )
                }),
                recommended: !existing.writable && existing.readable,
            });
        }
        cards.push(Card {
            kind: Kind::CreateHere,
            path: self.project.clone(),
            title: "Make a fresh home in this project".to_string(),
            facts: vec![
                format!("{} - empty, and private to this app", self.project.display()),
                "the pack is installed into it next (one press, no network)".to_string(),
            ],
            available: true,
            unavailable: None,
            recommended: self.existing.is_none(),
        });
        cards
    }

    /// The card the screen opens on: the recommended one, else the first available one.
    pub fn preselected(&self) -> Option<Card> {
        let cards = self.cards();
        cards
            .iter()
            .find(|card| card.recommended && card.available)
            .or_else(|| cards.iter().find(|card| card.available))
            .cloned()
    }
}

/// What is in the existing home now, in words - the facts the first card earns its
/// recommendation with.
fn describe(existing: &Existing) -> Vec<String> {
    let mut facts = vec![existing.path.display().to_string()];
    facts.push(if existing.bundles == 0 {
        "no web profile yet".to_string()
    } else if existing.has_pack {
        format!("the pack is installed · {} bundles", existing.bundles)
    } else {
        format!(
            "a web profile with {} bundles, without this pack (Install adds it here)",
            existing.bundles
        )
    });
    if existing.sessions > 0 {
        facts.push(format!(
            "{} session{}",
            existing.sessions,
            if existing.sessions == 1 { "" } else { "s" }
        ));
    }
    if existing.key {
        facts.push("a key is here".to_string());
    }
    facts.push("shared with `dsh web` and run-web.bat, not copied".to_string());
    facts
}

/// What a copy would bring, in words. Says plainly when there is nothing to bring.
fn facts_brought(existing: &Existing) -> Vec<String> {
    let mut brought = Vec::new();
    if existing.sessions > 0 {
        brought.push(format!("{} session(s)", existing.sessions));
    }
    if existing.key {
        brought.push("your key, if you tick it".to_string());
    }
    brought.push("skills, storages and attachments".to_string());
    if existing.has_pack {
        brought.push("the pack is installed into the copy afterwards".to_string());
    }
    if brought.is_empty() {
        brought.push("nothing durable is there to bring".to_string());
    }
    brought
}

/// How many files a directory holds, without reading any of them. A directory that
/// cannot be listed counts as none: this is a fact for a card, not a probe.
fn count_files(directory: &Path) -> usize {
    std::fs::read_dir(directory)
        .map(|entries| entries.flatten().filter(|entry| entry.path().is_file()).count())
        .unwrap_or(0)
}

/// Whether a credentials file holds anything - by SIZE, never by reading it.
fn credentials_hold_something(path: &Path) -> bool {
    std::fs::metadata(path).map(|meta| meta.len() > 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = match std::env::var_os("VNCODE_TEST_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => std::env::temp_dir(),
        };
        let path = root.join(format!("vncode-firstrun-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A home shaped like a real installation: a profile listing the pack, sessions,
    /// and a credentials file with content in it.
    fn installation(root: &Path, name: &str) -> PathBuf {
        let home = root.join(name);
        std::fs::create_dir_all(profile::directory(&home, crate::launch::PROFILE)).unwrap();
        std::fs::write(
            profile::directory(&home, crate::launch::PROFILE).join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-rightbar","dsh-editor"]}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.join("sessions")).unwrap();
        for index in 0..3 {
            std::fs::write(home.join("sessions").join(format!("c{index}.json")), b"{}").unwrap();
        }
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::write(home.join(".credentials.yaml"), b"deepseek: {apiKey: x}\n").unwrap();
        home
    }

    #[test]
    fn an_installation_that_can_be_written_offers_three_cards_and_recommends_using_it() {
        let root = scratch("three-cards");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let place = Where::survey(Some(&home), &app_root);

        let cards = place.cards();
        assert_eq!(cards.len(), 3, "all three answers must be offered: {cards:#?}");
        let use_it = &cards[0];
        assert_eq!(use_it.kind, Kind::UseExisting);
        assert!(use_it.available);
        assert!(use_it.recommended, "a home with the pack in it is the one to suggest");
        assert!(use_it.facts.iter().any(|fact| fact.contains("3 bundles")), "{:?}", use_it.facts);
        assert!(use_it.facts.iter().any(|fact| fact.contains("3 sessions")), "{:?}", use_it.facts);
        assert!(use_it.facts.iter().any(|fact| fact.contains("a key is here")), "{:?}", use_it.facts);

        let copy = &cards[1];
        assert_eq!(copy.kind, Kind::CopyExisting);
        assert!(copy.available);
        assert_eq!(copy.path, place.project);
        assert!(copy.facts.iter().any(|fact| fact.contains("your key, if you tick it")));

        let create = &cards[2];
        assert_eq!(create.kind, Kind::CreateHere);
        assert!(create.available);
        assert!(!create.recommended);
        // Every card lands somewhere real, and the choice says where.
        assert_eq!(Choice::new(Kind::UseExisting).home(&place), home);
        assert_eq!(Choice::new(Kind::CopyExisting).home(&place), place.project);
        assert_eq!(Choice::new(Kind::CreateHere).home(&place), place.project);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_home_that_cannot_be_written_offers_the_copy_and_says_why() {
        // THE MEASURED CASE. A confinement that refuses `%LOCALAPPDATA%` refuses
        // `~/.dsh` with it, so "use it in place" is impossible for any process - the
        // harness must compose its profile into the home on boot. The copy is the way
        // through, because a copy only has to READ the source, and the pack is then
        // installed into the copy.
        let root = scratch("read-only");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let mut place = Where::survey(Some(&home), &app_root);
        // Stand in for the confinement: the survey says "writable" because this account
        // can write there, so the fact is forced to what a confined child would see.
        place.existing.as_mut().unwrap().writable = false;

        let cards = place.cards();
        let use_it = &cards[0];
        assert!(!use_it.available, "a home that cannot be written must not be offered to use");
        assert!(
            use_it.unavailable.as_deref().unwrap().contains("cannot be written from this context"),
            "{:?}",
            use_it.unavailable
        );
        let copy = &cards[1];
        assert!(copy.available, "the copy is available whenever the source can be READ");
        assert!(copy.recommended, "and it is the one to suggest in that case");
        assert!(place.preselected().map(|card| card.kind) == Some(Kind::CopyExisting));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_source_that_cannot_be_read_offers_only_a_fresh_home() {
        let root = scratch("unreadable");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let mut place = Where::survey(Some(&home), &app_root);
        let existing = place.existing.as_mut().unwrap();
        existing.writable = false;
        existing.readable = false;
        let cards = place.cards();
        assert!(!cards[0].available);
        assert!(!cards[1].available);
        assert!(cards[1].unavailable.as_deref().unwrap().contains("cannot be read"));
        assert!(cards[2].available);
        assert_eq!(place.preselected().map(|card| card.kind), Some(Kind::CreateHere));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_machine_with_no_harness_home_shows_one_card_and_no_clutter() {
        let root = scratch("nothing");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let place = Where::survey(None, &app_root);
        let cards = place.cards();
        assert_eq!(cards.len(), 1, "there is nothing to say about a home that is not there");
        assert_eq!(cards[0].kind, Kind::CreateHere);
        assert!(cards[0].recommended);
        assert!(place.preselected().is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_writable_home_without_the_pack_is_still_the_one_to_suggest() {
        // It holds the person's sessions and key, and the installer adds the pack to it
        // IN PLACE - so it is a better answer than a fresh home, not a worse one. The
        // card has to say the pack is missing, or "recommended" would be misleading.
        let root = scratch("no-pack");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        std::fs::write(
            profile::directory(&home, crate::launch::PROFILE).join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}"#,
        )
        .unwrap();
        let place = Where::survey(Some(&home), &app_root);
        let cards = place.cards();
        assert!(cards[0].available);
        assert!(cards[0].recommended, "a writable home with your sessions in it is the answer");
        assert!(
            cards[0].facts.iter().any(|fact| fact.contains("without this pack (Install adds it here)")),
            "the card must say the pack is not there: {:?}",
            cards[0].facts
        );
        assert!(!cards[1].recommended, "the copy is for a home that cannot be written");
        assert!(!cards[2].recommended);
        assert_eq!(place.preselected().map(|card| card.kind), Some(Kind::UseExisting));
        let _ = std::fs::remove_dir_all(&root);
    }
}
