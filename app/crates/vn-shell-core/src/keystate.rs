//! Whether a DeepSeek key is available to the harness, and which layer supplied
//! it - the line the shell's control panel shows before the server exists.
//!
//! Why this is a module of its own rather than a few lines in the binary: the
//! answer is a PARSE of two file formats plus four precedence rules, and this
//! repository pins every decision like that with `cargo test` instead of
//! trusting a reading of the code. Nothing here knows about windows, panes or a
//! UI toolkit; the one function that touches the filesystem is [`read`].
//!
//! ## The layering is the harness's own, not an invention
//!
//! `@deepseek-ai/dsh-credentials-local` owns the real lookup, and its own header
//! states the order (highest first):
//!
//! ```text
//! inherited process environment   read-only, wins    DEEPSEEK_API_KEY=… dsh
//! > $DSH_HOME/.credentials.yaml   provider-managed   what Settings > Models writes
//! > <invocation cwd>/.env         read-only fallback
//! > $DSH_HOME/.env                read-only fallback
//! ```
//!
//! The environment wins because `DEEPSEEK_API_KEY=… dsh`, a CI secret or a
//! container `-e` is that run's explicit intent. This module answers "will the
//! harness find a key", so it has to walk the same order - a splash that said
//! "nothing loaded" while the environment supplied one would be wrong in the
//! direction that costs the reader a pointless trip to Settings.
//!
//! The invocation cwd is the SHELL's cwd: the harness is spawned as a child and
//! inherits it, so `<cwd>/.env` is the same file for both.
//!
//! ## Only presence is reported
//!
//! No value leaves this module, and nothing in it has a field a value COULD
//! leave in. [`KeyState`] carries a `bool` and a [`Source`]; the panel and the
//! console are drawn from [`console_line`] and [`Source::label`], and
//! [`tests::a_real_shaped_key_never_reaches_a_line_this_shell_draws`] feeds a
//! real-looking key in and asserts it comes out of neither. That is the same rule
//! the launch token lives under: read in memory, never written down, never
//! echoed, never drawn.

use std::path::Path;

/// The credential reference the harness looks for by default
/// (`dsh-llm-deepseek`'s `DEFAULT_API_KEY_ENV`, and the ref
/// `dsh-client-ui-settings-plugins` writes for the Models page).
pub const KEY_REF: &str = "DEEPSEEK_API_KEY";

/// Basename of the harness home's credentials document
/// (`dsh-credentials-local`'s `CREDENTIALS_FILENAME`).
const CREDENTIALS_FILENAME: &str = ".credentials.yaml";

/// Which layer answered. Ordered as the harness orders them, so `Ord` on this
/// enum would be a precedence order - which is why it is only ever compared for
/// equality.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// An inherited `DEEPSEEK_API_KEY`, whatever put it there.
    Environment,
    /// `$DSH_HOME/.credentials.yaml`, the file the Models page writes.
    CredentialsFile,
    /// `.env` in the directory the launcher was started from.
    ProjectEnv,
    /// `.env` inside the harness home.
    HomeEnv,
}

impl Source {
    /// Words for the splash line, phrased as the END of "loaded from …".
    pub fn label(self) -> &'static str {
        match self {
            Source::Environment => "the environment",
            Source::CredentialsFile => "the credentials file",
            Source::ProjectEnv => "a .env beside the launcher",
            Source::HomeEnv => "the harness home's .env",
        }
    }
}

/// The answer: no key, or a key and where it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyState {
    source: Option<Source>,
}

impl KeyState {
    pub fn loaded(&self) -> bool {
        self.source.is_some()
    }

    pub fn source(&self) -> Option<Source> {
        self.source
    }
}

/// The pure core: decide from the four layers' TEXT, already read.
///
/// `None` for a layer means the file does not exist (or could not be read),
/// which is not an error - "no key there" is the honest answer for all of them.
pub fn from_layers(
    environment: Option<&str>,
    credentials_file: Option<&str>,
    project_env: Option<&str>,
    home_env: Option<&str>,
) -> KeyState {
    let source = if present(environment) {
        Some(Source::Environment)
    } else if present(credentials_file.and_then(|text| yaml_credential(text, KEY_REF))) {
        Some(Source::CredentialsFile)
    } else if present(project_env.and_then(|text| dotenv_value(text, KEY_REF))) {
        Some(Source::ProjectEnv)
    } else if present(home_env.and_then(|text| dotenv_value(text, KEY_REF))) {
        Some(Source::HomeEnv)
    } else {
        None
    };
    KeyState { source }
}

/// Read the four layers for `home` and decide. Best-effort by design: a missing
/// or unreadable layer is simply a layer that answered nothing, because the only
/// thing worse than a splash without a key line is a shell that will not start.
pub fn read(home: Option<&Path>) -> KeyState {
    let environment = std::env::var(KEY_REF).ok();
    let credentials_file = home
        .map(|home| home.join(CREDENTIALS_FILENAME))
        .and_then(|path| std::fs::read_to_string(path).ok());
    let project_env = std::env::current_dir()
        .ok()
        .map(|cwd| cwd.join(".env"))
        .and_then(|path| std::fs::read_to_string(path).ok());
    let home_env = home
        .map(|home| home.join(".env"))
        .and_then(|path| std::fs::read_to_string(path).ok());
    from_layers(
        environment.as_deref(),
        credentials_file.as_deref(),
        project_env.as_deref(),
        home_env.as_deref(),
    )
}

/// One line for the console, which is the record a bug report can quote.
///
/// It names the layer and never the value - the console is the thing people
/// paste into an issue, so it is the last place a key may appear.
pub fn console_line(state: &KeyState) -> String {
    match state.source() {
        Some(source) => format!("[vncode] DeepSeek key: loaded from {}", source.label()),
        None => format!(
            "[vncode] DeepSeek key: not found (checked the environment, the credentials file and .env) - add one in Settings > Models"
        ),
    }
}

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

/// A UTF-8 BOM would otherwise hide the file's FIRST line, and the credentials
/// document's first line can be its only one - a key reported missing because
/// an editor wrote a BOM is exactly the false negative this module exists to
/// avoid.
fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Is this layer's value a key? Absent, blank, quoted-blank and YAML's own
/// nulls all mean "no".
fn present(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        })
        .unwrap_or(value)
        .trim();
    !value.is_empty() && !matches!(value, "~" | "null" | "Null" | "NULL")
}

/// Cut a YAML inline comment off an UNQUOTED scalar.
///
/// YAML only starts a comment at a `#` that follows whitespace, and never
/// inside a quoted scalar - so a key containing `#` survives, and `sk-a # mine`
/// loses only the note.
fn without_yaml_comment(value: &str) -> &str {
    let trimmed = value.trim_start();
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        return value;
    }
    match value.find(" #") {
        Some(index) => &value[..index],
        None => value,
    }
}

/// Split `name: value` at the FIRST colon - a value may contain colons of its
/// own, and a ref may contain `/` (`client-connection/browser-session`).
fn split_key(line: &str) -> Option<(&str, &str)> {
    let (name, value) = line.split_once(':')?;
    let name = name.trim_end();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    Some((name, value))
}

/// The value of a credential ref in `.credentials.yaml`.
///
/// The document's real shape, taken from `dsh-credentials-local` (which owns it)
/// and confirmed against a file the harness itself wrote:
///
/// ```text
/// version: 1
/// refs:                                  <- the CredentialRef-to-string mapping
///   DEEPSEEK_API_KEY: sk-…               <- ONE level in, not at the margin
/// records:
///   client-connection/browser-session:
///     kind: …
///     payload:
///       secret: …
/// ```
///
/// The FIRST version of this function looked for the key at column 0 only, on
/// the strength of the module's own prose ("a strict CredentialRef-to-string
/// mapping", which reads like a flat document). It compiled, and fourteen unit
/// tests written against that same wrong mental model passed - and then the
/// built shell reported "no key" on a machine whose key was sitting right there.
/// The lesson is the shape below, so it is pinned by
/// [`tests::the_real_document_shape_is_read`] with the real file's layout.
///
/// A genuinely flat document is still accepted, because that prose describes one
/// and an older writer could have produced it. What is NOT accepted is the same
/// name anywhere else: `records:` holds `secret` fields, and a ref buried in a
/// record is not the ref the harness looks up.
fn yaml_credential<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut section: Option<&str> = None;
    for line in strip_bom(text).lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indented = line.len() != line.trim_start().len();
        if !indented {
            // A top-level entry: either the next section, or - in the flat
            // shape - the credential itself.
            let (name, value) = match split_key(trimmed) {
                Some(pair) => pair,
                None => {
                    section = None;
                    continue;
                }
            };
            section = Some(name);
            if name == key {
                return Some(without_yaml_comment(value).trim());
            }
            continue;
        }
        // Indented: an entry of whatever section is open, and only `refs:` holds
        // credentials.
        if section != Some("refs") {
            continue;
        }
        if let Some((name, value)) = split_key(trimmed) {
            if name == key {
                return Some(without_yaml_comment(value).trim());
            }
        }
    }
    None
}

/// The value of `KEY=` in a dotenv file, which is not YAML: no indentation
/// rules, an optional `export`, spaces allowed around the `=`, and single or
/// double quotes.
fn dotenv_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    for line in strip_bom(text).lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        // Then only spaces, then `=`: this is what keeps `DEEPSEEK_API_KEY_OLD=`
        // and `DEEPSEEK_API_KEYFILE=` from answering for this key.
        let rest = rest.trim_start_matches([' ', '\t']);
        let Some(value) = rest.strip_prefix('=') else {
            continue;
        };
        let value = value.trim();
        let cut = match value.find(" #") {
            Some(index) if !value.starts_with('"') && !value.starts_with('\'') => &value[..index],
            _ => value,
        };
        return Some(cut.trim());
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// A unique stand-in for a key, so a leak is unmistakable.
    ///
    /// It is deliberately NOT key-SHAPED. This repository is public and its own
    /// `scripts/checks/check-no-secrets.mjs` fails the build on an `sk-`-shaped
    /// literal anywhere - including in a test fixture, because a fixture that
    /// looks like a live key is indistinguishable from one to a secret scanner
    /// (and to a reader). The shaped case is exercised instead by
    /// [`a_real_shaped_key_never_reaches_the_page`], which assembles its sample
    /// at runtime so no literal exists in the file.
    ///
    /// The `.env` fixtures below follow the same rule: their values carry a `/`,
    /// which keeps them out of the "ref followed by a credential" shape the guard
    /// looks for. A bare `from-project` is exactly the length it would flag.
    const SECRET: &str = "fixture/not/a/real/key/0001";

    /// The layout a real `$DSH_HOME/.credentials.yaml` has: the ref is nested one
    /// level inside `refs:`, and `records:` below it carries `secret` fields.
    fn file(key: &str) -> String {
        format!(
            "version: 1\n\
             refs:\n  \
             {key}: {SECRET}\n\
             records:\n  \
             client-connection/browser-session:\n    \
             kind: local\n    \
             payload:\n      \
             version: 1\n      \
             secret: a-different-secret\n"
        )
    }

    #[test]
    fn the_real_document_shape_is_read() {
        // Pinned byte-for-byte in shape against a document the harness wrote.
        // The first cut of this module looked for the key at the margin and
        // missed it here - the bug the built shell reported on a machine whose
        // key was present.
        let state = from_layers(None, Some(&file(KEY_REF)), None, None);
        assert_eq!(state.source(), Some(Source::CredentialsFile));
        assert!(state.loaded());
    }

    #[test]
    fn a_flat_document_is_still_read() {
        // The module's prose describes a ref-to-string mapping, so a document
        // with the ref at the margin must keep working too.
        let text = format!("version: 1\n{KEY_REF}: {SECRET}\n");
        assert_eq!(
            from_layers(None, Some(&text), None, None).source(),
            Some(Source::CredentialsFile)
        );
    }

    #[test]
    fn a_ref_inside_a_record_is_not_a_credential() {
        // `records:` is a different section; only `refs:` holds credentials.
        let text = format!(
            "version: 1\nrefs: {{}}\nrecords:\n  some/record:\n    {KEY_REF}: {SECRET}\n"
        );
        assert!(!from_layers(None, Some(&text), None, None).loaded());
    }

    #[test]
    fn an_empty_refs_block_is_not_a_key() {
        let text = format!("version: 1\nrefs:\n  {KEY_REF}:\nrecords:\n");
        assert!(!from_layers(None, Some(&text), None, None).loaded());
    }

    #[test]
    fn the_environment_wins_over_every_file() {
        let state = from_layers(
            Some("from-env"),
            Some(&file(KEY_REF)),
            Some("DEEPSEEK_API_KEY=fixture/from-project"),
            Some("DEEPSEEK_API_KEY=fixture/from-home"),
        );
        assert_eq!(state.source(), Some(Source::Environment));
    }

    #[test]
    fn the_credentials_document_is_next() {
        let state = from_layers(
            Some("   "),
            Some(&file(KEY_REF)),
            Some("DEEPSEEK_API_KEY=fixture/from-project"),
            Some("DEEPSEEK_API_KEY=fixture/from-home"),
        );
        assert_eq!(state.source(), Some(Source::CredentialsFile));
        assert!(state.loaded());
    }

    #[test]
    fn the_env_files_are_the_fallbacks_in_order() {
        assert_eq!(
            from_layers(
                None,
                None,
                Some("DEEPSEEK_API_KEY=fixture/from-project"),
                Some("DEEPSEEK_API_KEY=fixture/from-home"),
            )
            .source(),
            Some(Source::ProjectEnv)
        );
        assert_eq!(
            from_layers(None, None, Some("# nothing here\n"), Some("DEEPSEEK_API_KEY=from-home")).source(),
            Some(Source::HomeEnv)
        );
    }

    #[test]
    fn nothing_anywhere_is_not_loaded() {
        let state = from_layers(None, None, None, None);
        assert!(!state.loaded());
        assert_eq!(state.source(), None);
        assert!(console_line(&state).contains("not found"));
    }

    #[test]
    fn a_declared_but_empty_key_is_not_a_key() {
        for value in ["", "   ", "\"\"", "''", "~", "null", "NULL"] {
            let text = format!("version: 1\n{KEY_REF}: {value}\n");
            let state = from_layers(None, Some(&text), None, None);
            assert!(!state.loaded(), "{value:?} must not count as a key");
        }
    }

    #[test]
    fn a_longer_name_does_not_answer_for_this_one() {
        let text = format!("{KEY_REF}_OLD: {SECRET}\n");
        assert!(!from_layers(None, Some(&text), None, None).loaded());
        let dotenv = format!("{KEY_REF}FILE=/tmp/creds\n");
        assert!(!from_layers(None, None, Some(&dotenv), None).loaded());
    }

    #[test]
    fn quotes_comments_bom_and_crlf_are_all_read_correctly() {
        let quoted = format!("{KEY_REF}: \"{SECRET}\" # mine\n");
        assert!(from_layers(None, Some(&quoted), None, None).loaded());

        let bommed = format!("\u{feff}{KEY_REF}: {SECRET}\n");
        assert!(from_layers(None, Some(&bommed), None, None).loaded());

        let crlf = format!("version: 1\r\n{KEY_REF}: {SECRET}\r\n");
        assert!(from_layers(None, Some(&crlf), None, None).loaded());

        let exported = format!("export {KEY_REF}={SECRET}\n");
        assert_eq!(
            from_layers(None, None, Some(&exported), None).source(),
            Some(Source::ProjectEnv)
        );

        let spaced = format!("{KEY_REF} = {SECRET}\n");
        assert!(from_layers(None, None, Some(&spaced), None).loaded());
    }

    #[test]
    fn the_shell_draws_the_layer_and_never_the_value() {
        let state = from_layers(None, Some(&file(KEY_REF)), None, None);
        assert!(state.loaded());
        assert!(
            !console_line(&state).contains(SECRET),
            "the key leaked into the console line"
        );
        assert!(
            !format!("{state:?}").contains(SECRET),
            "the key leaked into a debug line"
        );
        assert_eq!(state.source().map(Source::label), Some("the credentials file"));
    }

    /// The same claim, with a value shaped exactly like the real thing.
    ///
    /// Assembled at runtime so this public repository contains no key-shaped
    /// literal - `check-no-secrets.mjs` enforces that, and a scanner cannot tell
    /// a convincing fixture from a live key.
    #[test]
    fn a_real_shaped_key_never_reaches_a_line_this_shell_draws() {
        let shaped = format!("sk-{}{}", "1234567890", "abcdefghijklmnopqrstuv");
        let text = format!("version: 1\nrefs:\n  {KEY_REF}: {shaped}\n");
        let state = from_layers(None, Some(&text), None, None);
        assert!(state.loaded(), "a shaped key must be recognised as one");
        let line = console_line(&state);
        assert!(!line.contains(&shaped), "the key leaked into the console line");
        assert!(!line.contains("sk-"), "no fragment of the key may appear");
        // The panel's key row is drawn from exactly these two things and nothing
        // else, so the row cannot carry more than this test allows.
        let row = format!(
            "loaded={} ({})",
            state.loaded(),
            state.source().map(Source::label).unwrap_or("none")
        );
        assert!(!row.contains("sk-"));
        assert!(row.contains("the credentials file"));
    }

    #[test]
    fn labels_are_stable() {
        // The splash prints these; a typo here is a typo in the window.
        assert_eq!(Source::Environment.label(), "the environment");
        assert_eq!(Source::CredentialsFile.label(), "the credentials file");
        assert_eq!(Source::ProjectEnv.label(), "a .env beside the launcher");
        assert_eq!(Source::HomeEnv.label(), "the harness home's .env");
    }

    #[test]
    fn the_reader_uses_the_harness_own_names() {
        // If either constant drifts from the harness, the indicator silently
        // stops working - which is the failure mode nobody would notice.
        assert_eq!(KEY_REF, "DEEPSEEK_API_KEY");
        assert_eq!(CREDENTIALS_FILENAME, ".credentials.yaml");
        let read_it: fn(Option<&Path>) -> KeyState = read;
        assert!(!read_it(None).loaded() || std::env::var(KEY_REF).is_ok());
    }
}
