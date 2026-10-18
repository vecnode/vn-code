//! The flags and the verbs, mirroring `scripts\run-web.bat` / `scripts/run-web.sh`,
//! so the app and the launchers stay interchangeable.
//!
//! Both spellings of each flag are accepted (`-Port` and `--port`) and matching is
//! case-insensitive, because `-Port` is what the batch files document and `--port` is what
//! a shell user types. An unknown flag, and an unknown verb, are an ERROR that names what
//! was not understood: the things a typo turns into are the ones that decide which harness
//! home is used and which script is run.
//!
//! There is no `-Mode` any more, and its absence is the change this shell is made of: it
//! draws no window and no web view, so "panel or browser or embed" ceased to be a choice.
//! What is left is what it DOES - install, ask for the key, start the web launcher - and
//! each of those is a verb.

use std::fmt;

/// What this run is asked to do.
///
/// `Start` is what no verb means: the whole path, from "is the pack installed" to "the
/// browser has the page".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Install the pack if the profile lacks it, ask for the key if there is none, then
    /// run `scripts/run-web.*` in the foreground.
    Start,
    /// Run `scripts/setup/install.*` against the home in use.
    Install,
    /// Run the matching pair.
    Uninstall,
    /// Print the facts and start nothing.
    Status,
    /// Ask for the DeepSeek key and write it into `<home>/.env`.
    Key,
}

impl Command {
    pub fn name(self) -> &'static str {
        match self {
            Command::Start => "start",
            Command::Install => "install",
            Command::Uninstall => "uninstall",
            Command::Status => "status",
            Command::Key => "key",
        }
    }

    pub fn parse(value: &str) -> Result<Command, String> {
        match value.to_ascii_lowercase().as_str() {
            "start" | "run" => Ok(Command::Start),
            "install" | "add" => Ok(Command::Install),
            "uninstall" | "remove" => Ok(Command::Uninstall),
            "status" | "info" => Ok(Command::Status),
            "key" | "token" => Ok(Command::Key),
            other => Err(format!(
                "unknown command '{other}' - expected one of start, install, uninstall, status or key \
                 (no command means start)"
            )),
        }
    }
}

impl fmt::Display for Command {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

/// The flags this shell parses.
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Options {
    /// What to do; `None` is `Command::Start`.
    pub command: Option<Command>,
    /// Explicit port handed to the web launcher; 0 means "let the harness decide".
    pub port: u16,
    pub dsh_home: Option<String>,
    pub dsh_version: Option<String>,
    pub help: bool,
    pub version: bool,
}

impl Options {
    /// The verb this run will perform.
    pub fn command(&self) -> Command {
        self.command.unwrap_or(Command::Start)
    }
}

/// Parse the flags and the one optional verb.
pub fn parse_args(args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options::default();
    let mut args = args;
    while let Some(argument) = args.next() {
        let name = argument.to_ascii_lowercase();
        match name.as_str() {
            "-port" | "--port" => {
                let value = next_value(&mut args, "-Port")?;
                options.port = value
                    .parse::<u16>()
                    .map_err(|_| format!("-Port expects a port number, got '{value}'"))?;
                if options.port == 0 {
                    return Err("-Port expects a port number above zero".to_string());
                }
            }
            "-dshhome" | "--dshhome" => options.dsh_home = Some(next_value(&mut args, "-DshHome")?),
            "-dshversion" | "--dshversion" => {
                options.dsh_version = Some(next_value(&mut args, "-DshVersion")?)
            }
            "-help" | "--help" | "-h" | "/?" => options.help = true,
            "-version" | "--version" | "-v" => options.version = true,
            other if other.starts_with('-') || other.starts_with('/') => {
                return Err(format!(
                    "unknown flag '{other}' - run `vncode -Help` for the accepted flags"
                ))
            }
            verb => {
                // ONE verb, and it goes first by convention - but a flag before it is
                // ordinary (`vncode -DshHome C:\h start`), so the verb is taken wherever
                // it appears rather than only at argv[0].
                let parsed = Command::parse(verb)?;
                if options.command.is_some() {
                    return Err(format!(
                        "only one command may be given - this run already asked for '{}'",
                        options.command().name()
                    ));
                }
                options.command = Some(parsed);
            }
        }
    }
    Ok(options)
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} needs a value after it"))
}

/// The usage text. One string, so the verbs and flags this shell accepts live in exactly
/// one place and a check can drive the binary and read it back.
pub const USAGE: &str = "\
Usage: vncode [start|install|uninstall|status|key] [flags]

  (no command)       install the pack if this home lacks it, ask for the DeepSeek key
                     if there is none, then start the harness and open it - this runs
                     scripts/run-web.bat (Windows) or scripts/run-web.sh, in the
                     foreground, exactly as double-clicking that file does
  start              the same thing, spelled out
  install            run scripts/setup/install.* against the home in use
  uninstall          run scripts/setup/uninstall.* against it
  status             print the pin, the home and why it was chosen, the pack, the key
                     layer and where the launcher is; start nothing
  key                ask for the DeepSeek key and write it into <home>/.env (0600)

  -Port <n>          hand this port to the web launcher instead of the harness default
  -DshHome <dir>     use this harness home instead of the one the app chose
                     (a leading ~ is expanded; a relative path is resolved here)
  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
  -Help              print this help
  -Version           print the version

vncode is the app's front door, not a second harness: it decides the root, the key and
the pack, and then runs the SAME scripts a person would run. Launching only the web
needs none of this - scripts/run-web.bat or ./scripts/run-web.sh works on its own.

The app owns a root ($VNCODE_HOME) and the harness home is <root>/home inside it. This
command never draws the interface: the page opens in a browser it found.";

pub fn print_usage() {
    println!();
    println!("{USAGE}");
    println!();
}

pub fn print_version() {
    println!("vncode {}", env!("CARGO_PKG_VERSION"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> std::vec::IntoIter<String> {
        list.iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn the_flags_run_web_documents_are_accepted_in_both_spellings() {
        let options =
            parse_args(args(&["-Port", "3099", "-DshHome", "/tmp/h", "-DshVersion", "9.9.9"]))
                .unwrap();
        assert_eq!(options.port, 3099);
        assert_eq!(options.dsh_home.as_deref(), Some("/tmp/h"));
        assert_eq!(options.dsh_version.as_deref(), Some("9.9.9"));

        let long = parse_args(args(&["--port", "3098", "--dshhome", "/tmp/g"])).unwrap();
        assert_eq!(long.port, 3098);
        assert_eq!(long.dsh_home.as_deref(), Some("/tmp/g"));
    }

    #[test]
    fn no_command_is_start_and_every_command_parses() {
        assert_eq!(parse_args(args(&[])).unwrap().command(), Command::Start);
        assert_eq!(parse_args(args(&["start"])).unwrap().command(), Command::Start);
        assert_eq!(parse_args(args(&["INSTALL"])).unwrap().command(), Command::Install);
        assert_eq!(parse_args(args(&["uninstall"])).unwrap().command(), Command::Uninstall);
        assert_eq!(parse_args(args(&["status"])).unwrap().command(), Command::Status);
        assert_eq!(parse_args(args(&["key"])).unwrap().command(), Command::Key);
        // A flag before the verb is ordinary, and the verb is found where it appears.
        let options = parse_args(args(&["-DshHome", "/tmp/h", "install"])).unwrap();
        assert_eq!(options.command(), Command::Install);
        assert_eq!(options.dsh_home.as_deref(), Some("/tmp/h"));
        // Two verbs is one too many.
        let error = parse_args(args(&["install", "status"])).unwrap_err();
        assert!(error.contains("only one command"), "{error}");
        let error = parse_args(args(&["sideways"])).unwrap_err();
        assert!(error.contains("unknown command 'sideways'"), "{error}");
        assert!(error.contains("start, install, uninstall, status or key"), "{error}");
    }

    #[test]
    fn an_unknown_flag_is_refused_and_named() {
        // The failure this prevents: a typo silently becoming a default, so the shell
        // runs a different harness or a different port than the one asked for.
        let error = parse_args(args(&["-Prot", "3099"])).unwrap_err();
        assert!(error.contains("-prot"), "{error}");
        assert!(error.contains("unknown flag"), "{error}");
    }

    #[test]
    fn a_flag_that_needs_a_value_says_so() {
        let error = parse_args(args(&["-DshHome"])).unwrap_err();
        assert!(error.contains("-DshHome needs a value"), "{error}");
    }

    #[test]
    fn port_zero_is_refused_rather_than_meaning_a_random_port() {
        assert!(parse_args(args(&["-Port", "0"]))
            .unwrap_err()
            .contains("above zero"));
        assert!(parse_args(args(&["-Port", "seventy"]))
            .unwrap_err()
            .contains("port number"));
    }

    #[test]
    fn there_is_no_mode_flag_any_more_and_no_embedded_web_view() {
        // The pane is gone. A `-Mode embed` that used to select it must FAIL, and the
        // usage text must not advertise a surface this build does not have.
        let error = parse_args(args(&["-Mode", "embed"])).unwrap_err();
        assert!(error.contains("unknown flag"), "{error}");
        for word in ["embed", "pane", "-Mode"] {
            assert!(!USAGE.contains(word), "the usage text still mentions {word}");
        }
        // ...and every verb and flag it DOES accept is named in it.
        for word in ["install", "uninstall", "status", "key", "-Port", "-DshHome", "-Help"] {
            assert!(USAGE.contains(word), "the usage text never mentions {word}");
        }
    }

    #[test]
    fn the_launchers_flags_are_not_silently_swallowed() {
        // -NoPause/-NoTerminal/-NoBuild belong to the launcher scripts and are stripped
        // there; reaching this parser means they were NOT stripped, and the shell must
        // say so rather than run with a flag it ignored.
        for flag in ["-NoPause", "-NoTerminal", "-NoBuild"] {
            assert!(parse_args(args(&[flag])).is_err(), "{flag} was accepted");
        }
    }

    #[test]
    fn help_and_version_are_flags_not_verbs() {
        assert!(parse_args(args(&["-Help"])).unwrap().help);
        assert!(parse_args(args(&["--help"])).unwrap().help);
        assert!(parse_args(args(&["-Version"])).unwrap().version);
        assert!(parse_args(args(&["--version"])).unwrap().version);
        // ...and asking for help is not asking for a verb.
        assert_eq!(parse_args(args(&["-Help"])).unwrap().command(), Command::Start);
    }
}
