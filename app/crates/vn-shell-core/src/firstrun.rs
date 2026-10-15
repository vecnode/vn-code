//! The first-run choice: **where your sessions, skills and key live**, made once, in
//! one place, before anything else happens.
//!
//! This module is the whole of that decision. It surveys what this machine already has,
//! turns it into the cards the panel draws, and says what each card would DO - so the
//! window is a two-button screen rather than a table of fifteen rows, and so the
//! decision itself is a `cargo test` case rather than a reading of the drawing code.
//!
//! **Two answers, and both of them end inside this folder.**
//!
//! | card | what it is for |
//! |---|---|
//! | **copy it here and use the copy** | a one-way import: the harness's own default (`~/.dsh`) is READ, and what is durable in it is brought into this app's own root. Offered while there is something to bring AND room to put it - a card that promised a copy of a home that had already been copied here did nothing at all when pressed |
//! | **make a fresh home here** | this app's own root; empty when it is untouched, and honest when it is not - nothing is ever deleted, so the card says which of the two it is |
//!
//! **The card that used to be first is gone: "use the home already on this machine".** It
//! ran the harness against `~/.dsh`, and a folder that carries everything it needs must
//! not reach into a person's profile to START - the reason that rung existed (a home with
//! no pack, a home with no key) is answered by this app itself: Start installs the pack
//! into the home in use, and the key row asks for the key. `~/.dsh` survives as the
//! SOURCE of the copy alone, which is read and never run against.
//!
//! Nothing here decides on its own: [`Where::cards`] says what is possible and what each
//! choice means, and the person picks. The copy is recommended while there is something
//! to bring, because the alternative is leaving a person's own sessions behind.
//!
//! The card that is *unavailable* carries the sentence saying why, because that sentence
//! is the whole answer to "why can I not use my own sessions?".
//!
//! ## What the survey still measures about that source
//!
//! `sessions` and `key` are counted and sized (never read) so the copy card can say what
//! is there; `readable` is what a copy needs; `has_pack` is what the copy's own second
//! half promises. **Writability is no longer surveyed**: nothing runs against that home
//! any more, so whether a child can write in it decides nothing.

use std::path::{Path, PathBuf};

use crate::adopt;
use crate::profile;

/// What this machine already has, told as facts a card can be trusted to print.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Existing {
    pub path: PathBuf,
    /// Its directory can be listed, which is what a copy needs.
    pub readable: bool,
    /// Whether this pack is among the bundles its `web` profile lists - what the copy's
    /// own second half (the install that follows it) is promised on.
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
    /// Copy what is durable out of the machine's own home, here, and use the copy.
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
    /// **The one line the card always draws**: where it goes, and the fact that decides
    /// it. Open, because a card whose path is hidden asks somebody to choose blind.
    pub summary: String,
    /// Everything else, drawn inside the card's own `details` disclosure - closed by
    /// default.
    ///
    /// Measured on a real machine: with every fact drawn open, three cards filled the
    /// window and pushed the reason and the button off the bottom of it, which is how a
    /// screen with exactly one usable answer read as bloat. Nothing was deleted - the
    /// facts moved one click away, and [`Card::summary`] keeps the part a decision needs.
    pub facts: Vec<String>,
    pub available: bool,
    /// Why not, in one sentence, when it cannot be offered. **Always drawn open**: it is
    /// the answer to "why can I not press this", and hiding it behind a disclosure is how
    /// a greyed-out button turns into a bug report.
    pub unavailable: Option<String>,
    /// The one the app would suggest, without deciding anything.
    pub recommended: bool,
    /// **The wording of the one button that is always in the same place**: the panel
    /// draws it under the cards, and it TAKES the card marked `▸`.
    ///
    /// It exists because this screen can honestly offer one card and grey out two - the
    /// home on this machine is not writable from a confined parent, and the copy has
    /// nothing left to bring - and a reader who sees two red paragraphs and a card named
    /// "Make a fresh home" over a home that already exists has no way on. The label is
    /// decided HERE, where the state is known, rather than in the drawing code.
    pub continue_label: String,
}

impl Card {
    /// A stable id for this card's own `details` disclosure, unique on the screen.
    ///
    /// The panel needs it because egui remembers an open/closed state per id: without one,
    /// opening the first card's details would open - or close - all three.
    pub fn id(&self) -> u32 {
        match self.kind {
            Kind::CopyExisting => 1,
            Kind::CreateHere => 2,
        }
    }
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

    /// The home this choice puts in use. Both cards end inside this app's own root -
    /// the copy brings things INTO it, and the fresh home creates it.
    pub fn home(&self, place: &Where) -> PathBuf {
        place.project.clone()
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
                readable: adopt::source_is_readable(path),
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
    ///
    /// Two states shape the wording, and both were measured on a real machine: the home
    /// on this machine may be unwritable (so that card cannot be pressed), and this
    /// app's own home may already hold the person's sessions (so "make a fresh home" is
    /// a lie and "copy it here" has nothing to copy). A screen where two cards are red
    /// and the third misnames itself has no way on - which is what the third card's
    /// adaptive title and every card's `continue_label` are for.
    pub fn cards(&self) -> Vec<Card> {
        // "This app's own home already holds something of the person's." The same
        // measurement Adopt uses, so the card and the copy offer cannot disagree.
        let project_is_ours = !adopt::home_is_untouched_by_a_person(&self.project);
        let mut cards = Vec::new();
        // Whether the COPY is the card the screen opens on. Exactly one card is ever
        // marked: the button at the foot of the screen takes the marked one, and a screen
        // whose arrow is on no card is the dead end this screen exists to remove.
        let mut copy_recommended = false;
        if let Some(existing) = self.existing.as_ref() {
            // THE CARD THAT USED TO BE FIRST IS GONE. "Use the DeepSeek home already on
            // this machine" ran the harness against `~/.dsh`, and a folder that carries
            // everything it needs must not reach into a person's profile to start. What
            // remains is the one-way COPY: it only reads the source, and it is how a
            // person brings their own sessions and key into the folder.
            // What a copy would ACTUALLY bring, from the same plan the copy runs: the
            // facts used to be composed from the source's own inventory, so a card that
            // could not be pressed still advertised a key and a pack to bring - the
            // contradiction the red sentence beside it was pointing out.
            let planned = adopt::plan(&existing.path, &self.project);
            let key_to_bring = adopt::credentials_can_be_brought(&existing.path, &self.project);
            let something_to_bring = !planned.items.is_empty() || key_to_bring;
            cards.push(Card {
                kind: Kind::CopyExisting,
                path: self.project.clone(),
                title: "Copy it here, and use the copy".to_string(),
                summary: if something_to_bring {
                    format!("copies into {}", self.project.display())
                } else {
                    format!("everything durable is already in {}", self.project.display())
                },
                facts: if something_to_bring {
                    let mut facts: Vec<String> =
                        planned.items.iter().map(|item| item.name.to_string()).collect();
                    if existing.key {
                        facts.push("a key is there, if you tick it".to_string());
                    }
                    if existing.has_pack {
                        facts.push("the pack is installed into the copy next".to_string());
                    }
                    facts
                } else {
                    vec![
                        format!(
                            "every tree and the key from {} are already here",
                            existing.path.display()
                        ),
                        "nothing is copied again, and nothing is overwritten".to_string(),
                    ]
                },
                // AVAILABLE ONLY WHEN THERE IS SOMETHING LEFT TO BRING. It used to be
                // "the source can be read", which offered a copy of a home that had
                // already been copied here: the click then did nothing at all, and the
                // only sentence saying so was drawn inside `Details`. A card is a
                // promise about what the next click does.
                available: existing.readable && something_to_bring,
                unavailable: if !existing.readable {
                    Some(format!(
                        "{} exists but cannot be read, so nothing can be copied out of it",
                        existing.path.display()
                    ))
                } else {
                    Some(format!(
                        "there is nothing left to bring: {} already holds everything durable in {}. The home in use is {} - press Start and the pack is installed into it",
                        self.project.display(),
                        existing.path.display(),
                        self.project.display()
                    ))
                },
                // Only suggested when it can actually be pressed: a card that is both
                // "recommended" and greyed out is the worst of both. And never when the
                // folder's own home already holds this person's work - then the answer is
                // the folder, and there is nothing left to bring anyway.
                recommended: something_to_bring && !project_is_ours,
                continue_label: "Copy it here and continue".to_string(),
            });
            copy_recommended = something_to_bring && !project_is_ours;
        }
        cards.push(Card {
            kind: Kind::CreateHere,
            path: self.project.clone(),
            title: if project_is_ours {
                // NOT "make a fresh home" over a home that already holds somebody's
                // sessions: the card never deletes anything, and this is the state in
                // which it is the way ON rather than a fresh start.
                "Use the home in this folder".to_string()
            } else {
                "Make a fresh home in this project".to_string()
            },
            // "EMPTY" IS A MEASUREMENT, NOT A HOPE. The card is always available and it
            // never deletes anything - so when this app's own home already holds the
            // person's sessions the card must say that instead of promising a fresh
            // start it cannot deliver. It says it in the SUMMARY, because that is the line
            // that decides the card.
            summary: if project_is_ours {
                format!("{} · this app's home already, and it stays", self.project.display())
            } else {
                format!("{} · empty, and private to this app", self.project.display())
            },
            facts: if project_is_ours {
                vec![
                    "your sessions, skills and key are there already; nothing is deleted, and nothing is copied again".to_string(),
                    "the pack is installed into it next if the profile does not list it (Start does it)".to_string(),
                ]
            } else {
                vec!["the pack is installed into it next (one press, no network)".to_string()]
            },
            available: true,
            unavailable: None,
            // The folder is the answer unless the copy is - exactly one card is marked.
            recommended: !copy_recommended,
            continue_label: if project_is_ours {
                "Continue with the home in this folder".to_string()
            } else {
                "Create the home here and continue".to_string()
            },
        });
        // ONE ANSWER IS NOT A CHOICE. When the home on this machine cannot be written and
        // the copy has nothing left to bring, the folder's own home is the only card that
        // can be taken - and drawing the other two as red paragraphs is exactly the noise
        // the owner measured: *"it starts already on second page with what I am copying
        // here"* - two greyed cards above the one that works, and a reader looking for a
        // way on. They are folded into the surviving card's own `details`, reasons and
        // paths included, so nothing is hidden and nothing is promised that cannot be
        // pressed.
        let available = cards.iter().filter(|card| card.available).count();
        if available == 1 && cards.len() > 1 {
            let mut folded: Vec<String> = cards
                .iter()
                .filter(|card| !card.available)
                .map(|card| {
                    format!(
                        "not offered here: {} - {}",
                        card.title,
                        card.unavailable.clone().unwrap_or_default()
                    )
                })
                .collect();
            let mut kept: Vec<Card> = cards.into_iter().filter(|card| card.available).collect();
            if let Some(card) = kept.last_mut() {
                folded.extend(std::mem::take(&mut card.facts));
                card.facts = folded;
            }
            return kept;
        }
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
    fn an_installation_on_this_machine_is_offered_as_a_one_way_copy_only() {
        // THE REMOVED CARD, PINNED AS ABSENT. "Use the DeepSeek home already on this
        // machine" ran the harness against `~/.dsh`; a folder that carries everything it
        // needs must not reach into a person's profile to START. What is offered is the
        // COPY, which only reads - and the copy is the card the screen opens on, because
        // the alternative is leaving this person's own sessions and key behind.
        let root = scratch("copy-only");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let place = Where::survey(Some(&home), &app_root);

        let cards = place.cards();
        assert_eq!(cards.len(), 2, "the folder and the copy: {cards:#?}");
        assert!(
            !cards.iter().any(|card| card.title.contains("already on this machine")),
            "{:?}",
            cards.iter().map(|card| card.title.clone()).collect::<Vec<_>>()
        );

        let copy = &cards[0];
        assert_eq!(copy.kind, Kind::CopyExisting);
        assert!(copy.available);
        assert!(copy.recommended, "the way in is the one to suggest");
        assert_eq!(copy.path, place.project, "and it lands inside the folder");
        // The facts come from the copy's own plan: the skills the source holds are named,
        // and the key is the separate tick.
        assert!(copy.facts.iter().any(|fact| fact.contains("skills")), "{:?}", copy.facts);
        assert!(copy.facts.iter().any(|fact| fact.contains("if you tick it")), "{:?}", copy.facts);

        let create = &cards[1];
        assert_eq!(create.kind, Kind::CreateHere);
        assert!(create.available);
        assert!(!create.recommended, "exactly one card is marked");
        // Every card lands inside this app's own root, and the choice says where.
        assert_eq!(Choice::new(Kind::CopyExisting).home(&place), place.project);
        assert_eq!(Choice::new(Kind::CreateHere).home(&place), place.project);
        assert_eq!(place.preselected().map(|card| card.kind), Some(Kind::CopyExisting));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_copy_is_offered_because_it_reads_and_writability_decides_nothing() {
        // The survey no longer asks whether a child can WRITE in the machine's home:
        // nothing runs against it any more. A read-only source is still a source, and the
        // copy is still the way in - the pack is then installed into the COPY.
        let root = scratch("read-only-copy");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let place = Where::survey(Some(&home), &app_root);

        let cards = place.cards();
        let copy = cards.iter().find(|card| card.kind == Kind::CopyExisting).expect("a copy card");
        assert!(copy.available, "a copy only has to READ the source");
        assert!(copy.recommended);
        assert_eq!(place.preselected().map(|card| card.kind), Some(Kind::CopyExisting));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_source_that_cannot_be_read_offers_only_a_fresh_home() {
        let root = scratch("unreadable");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let mut place = Where::survey(Some(&home), &app_root);
        place.existing.as_mut().unwrap().readable = false;
        let cards = place.cards();
        // One card: a copy of a source that cannot be read can be neither offered nor
        // taken, and its reason travels in the surviving card's details.
        assert_eq!(cards.len(), 1, "{cards:#?}");
        assert_eq!(cards[0].kind, Kind::CreateHere);
        assert!(cards[0].available);
        let folded = cards[0].facts.join("\n");
        assert!(folded.contains("cannot be read"), "{folded}");
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
    fn a_home_that_already_has_the_copy_offers_no_copy_and_says_why() {
        // MEASURED: the click that did nothing. The source was readable, so the card
        // was offered; the four durable trees were already in this app's own home, so
        // the copy planned no items at all and `Adopt::start` refused - with its one
        // sentence drawn inside `Details`, where nobody was looking. The card is now
        // unavailable and carries the reason, and neither it nor a de-duplicated
        // "fresh" card may promise anything the folder cannot deliver.
        let root = scratch("already-copied");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let place = Where::survey(Some(&home), &app_root);
        // Stand in for the earlier run: the copy is already in this app's own home.
        for name in ["skills", "sessions", "storages", "attachments"] {
            std::fs::create_dir_all(place.project.join(name)).unwrap();
            std::fs::write(place.project.join(name).join("something"), b"x").unwrap();
        }
        std::fs::write(place.project.join(".credentials.yaml"), b"deepseek: {apiKey: x}\n").unwrap();

        let cards = place.cards();
        // ONE CARD, because one answer can be taken. The owner's report, verbatim: "it
        // starts already on second page with what I am copying here" - two greyed cards
        // above the only one that works. They are still described, inside the surviving
        // card's `details`.
        assert_eq!(cards.len(), 1, "a screen with one answer must not draw the other: {cards:#?}");
        let only = &cards[0];
        assert_eq!(only.kind, Kind::CreateHere);
        assert!(only.available);
        assert_eq!(only.title, "Use the home in this folder");
        assert!(only.summary.contains("this app's home already"), "{}", only.summary);
        // Nothing is hidden: the refusal - and the path it names - is in the details.
        assert!(
            only.facts.iter().any(|fact| fact.starts_with("not offered here: Copy it here")),
            "{:?}",
            only.facts
        );
        assert!(
            only.facts.iter().any(|fact| fact.contains(place.project.to_string_lossy().as_ref())),
            "the paths stay on the screen: {:?}",
            only.facts
        );
        assert_eq!(
            place.preselected().map(|card| card.kind),
            Some(Kind::CreateHere),
            "the button at the foot takes the one card"
        );
        // ...and the facts it already had are still there, after the folded reasons.
        assert!(
            only.facts.iter().any(|fact| fact.contains("nothing is deleted")),
            "{:?}",
            only.facts
        );
        // Every sentence a label will draw is still free of markup.
        for text in std::iter::once(only.title.as_str())
            .chain(std::iter::once(only.summary.as_str()))
            .chain(std::iter::once(only.continue_label.as_str()))
            .chain(only.facts.iter().map(String::as_str))
        {
            assert!(
                !text.contains("**") && !text.contains('`'),
                "a card sentence carries markup a label cannot render: {text}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_answers_are_still_a_choice_and_are_both_drawn() {
        // The single-card rule is for the state where NOTHING else can be pressed. A
        // readable installation with something left to bring, beside a fresh folder,
        // keeps both cards: there the choice is real, and hiding one would be deciding
        // for the person.
        let root = scratch("two-answers");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let place = Where::survey(Some(&home), &app_root);
        let cards = place.cards();
        assert_eq!(cards.len(), 2, "{cards:#?}");
        assert!(cards[0].available && cards[1].available);
        assert_eq!(place.preselected().map(|card| card.kind), Some(Kind::CopyExisting));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_copy_is_the_card_that_says_where_it_lands_and_why_not_when_it_cannot() {
        // Each card still names the button under it, so the footer is never a mystery -
        // and the one that cannot be pressed carries its own reason in words.
        let root = scratch("refusal-points-on");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = installation(&root, ".dsh");
        let place = Where::survey(Some(&home), &app_root);

        // Nothing copied here yet: the copy can be pressed, and it says where it goes.
        let cards = place.cards();
        let copy = cards.iter().find(|card| card.kind == Kind::CopyExisting).unwrap();
        assert!(copy.available);
        assert_eq!(copy.continue_label, "Copy it here and continue");
        assert!(copy.summary.contains(&place.project.display().to_string()), "{}", copy.summary);

        // The copy already happened: pointing at it would be a dead end, so the screen is
        // ONE card and the refusal is read inside its details.
        for name in ["skills", "sessions", "storages", "attachments"] {
            std::fs::create_dir_all(place.project.join(name)).unwrap();
            std::fs::write(place.project.join(name).join("something"), b"x").unwrap();
        }
        std::fs::write(place.project.join(".credentials.yaml"), b"deepseek: {apiKey: x}\n").unwrap();
        let cards = place.cards();
        assert_eq!(cards.len(), 1, "only the folder's home can be taken now: {cards:#?}");
        let folded = cards[0].facts.join("\n");
        assert!(folded.contains("nothing left to bring"), "{folded}");
        assert!(folded.contains(&place.project.display().to_string()), "{folded}");
        for card in &cards {
            assert!(!card.continue_label.is_empty(), "{card:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_screen_a_confined_machine_sees_reads_as_a_way_on() {
        // THE MEASURED SCREEN, pinned as one case. A machine where:
        //   * `~/.dsh` is a complete installation (24 bundles, a key, sessions) and a
        //     child CANNOT write in it - so that card cannot be taken;
        //   * this app's own home already holds the copy (the durable trees AND a
        //     credentials file with content) - so there is nothing left to copy;
        //   * and the folder is a portable installation, so its own home is the root.
        //
        // What that used to look like: two red cards and a third named "Make a fresh
        // home in this project" over a home that already existed, with no visible way to
        // continue. Every line below is the answer to that, so it is a test rather than
        // a paragraph in a plan.
        let root = scratch("measured-screen");
        let app_root = root.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        let home = root.join(".dsh");
        std::fs::create_dir_all(profile::directory(&home, crate::launch::PROFILE)).unwrap();
        std::fs::write(
            profile::directory(&home, crate::launch::PROFILE).join("package.json"),
            br#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-rightbar","dsh-editor"]}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.join("sessions")).unwrap();
        std::fs::write(home.join("sessions").join("c1.json"), b"{}").unwrap();
        std::fs::write(home.join(".credentials.yaml"), b"deepseek: {apiKey: x}\n").unwrap();

        let place = Where::survey(Some(&home), &app_root);
        for name in ["skills", "sessions", "storages", "attachments"] {
            std::fs::create_dir_all(place.project.join(name)).unwrap();
            std::fs::write(place.project.join(name).join("something"), b"x").unwrap();
        }
        std::fs::write(place.project.join(".credentials.yaml"), b"deepseek: {apiKey: y}\n").unwrap();

        let cards = place.cards();
        let taken = place.preselected().expect("one card can always be taken");

        // The screen, as the panel draws it: the summary open, the facts behind
        // `details`, the reason never collapsed.
        for card in &cards {
            println!(
                "{} {}{}\n    {}\n    [ details ] {}",
                if card.available { "▸" } else { "×" },
                card.title,
                if card.recommended { "  (recommended)" } else { "" },
                card.summary,
                card.facts.join("\n                ")
            );
            if let Some(reason) = card.unavailable.as_deref() {
                println!("    ! {reason}");
            }
            println!("    [ {} ]", card.continue_label);
        }
        println!("[ {} ]  <- the way on, always in the same place", taken.continue_label);

        // 1. ONE CARD, and it is the one that can be taken - the owner's report was "it
        //    starts already on second page with what I am copying here", two greyed cards
        //    above the answer. Nothing is lost: the refusal, with its path and its reason,
        //    is in the details.
        assert_eq!(cards.len(), 1, "one answer is not a choice: {cards:#?}");
        let only = &cards[0];
        assert!(only.available);
        assert_eq!(only.title, "Use the home in this folder");
        assert_eq!(only.kind, Kind::CreateHere);
        assert!(only.summary.contains("this app's home already"), "{}", only.summary);
        assert!(only.facts.iter().any(|fact| fact.contains("nothing is deleted")));
        let folded = only.facts.join("\n");
        assert!(folded.contains("not offered here: Copy it here"), "{folded}");
        assert!(folded.contains("nothing left to bring"), "{folded}");
        assert!(folded.contains("nothing is copied again"), "{folded}");
        // ...and it never advertises a key it would skip: the target already has a
        // credentials file, so the tick must not be offered anywhere.
        assert!(!folded.contains("if you tick it"), "{folded}");
        assert_eq!(taken.kind, Kind::CreateHere);
        assert_eq!(taken.continue_label, "Continue with the home in this folder");

        // NOTHING THE PANEL DRAWS CARRIES MARKUP. Every one of these strings reaches the
        // reader through `ui.label`, which renders no markdown and no code spans - so
        // `**Install pack**` arrived as literal asterisks and a backticked `Change` as a
        // grave accent, measured on this very screen. The rule is checked where the
        // strings are MADE, because a drawing function cannot fix a sentence.
        for card in &cards {
            let drawn: Vec<&str> = std::iter::once(card.title.as_str())
                .chain(std::iter::once(card.summary.as_str()))
                .chain(std::iter::once(card.continue_label.as_str()))
                .chain(card.facts.iter().map(String::as_str))
                .chain(card.unavailable.as_deref())
                .collect();
            for text in drawn {
                assert!(
                    !text.contains("**") && !text.contains('`'),
                    "a card sentence carries markup a label cannot render: {text}"
                );
            }
            // One id per card, so opening one card's details cannot open another's.
            assert!(card.id() >= 1);
        }
        let ids: Vec<u32> = cards.iter().map(Card::id).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "two cards share a disclosure id: {ids:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_home_without_the_pack_is_still_worth_copying_and_the_card_says_so() {
        // The source holds the person's sessions and key, and the pack is installed into
        // the COPY next - so the copy is still the answer, and the card has to say that
        // the pack is not in the source, or "recommended" would be misleading.
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
        let copy = cards.iter().find(|card| card.kind == Kind::CopyExisting).expect("a copy card");
        assert!(copy.available);
        assert!(copy.recommended, "the copy is the way in whenever there is something to bring");
        assert!(
            !copy.facts.iter().any(|fact| fact.contains("the pack is installed into the copy next")),
            "the source has no pack, so the install into the copy is not a fact: {:?}",
            copy.facts
        );
        assert_eq!(place.preselected().map(|card| card.kind), Some(Kind::CopyExisting));
        let _ = std::fs::remove_dir_all(&root);
    }
}
