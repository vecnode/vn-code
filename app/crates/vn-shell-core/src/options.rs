//! The flags, mirroring `scripts\run-web.bat` / `scripts\run-desktop.bat`, so the
//! three stay interchangeable.
//!
//! Both spellings of each flag are accepted (`-Port` and `--port`) and matching is
//! case-insensitive, because `-Port` is what the batch files document and
//! `--port` is what a shell user types. An unknown flag is an ERROR that names
//! the flag, never something quietly ignored: the flags a typo turns into are the
//! ones that decide which harness runs and on which port.

use std::fmt;

/// The three shapes the shell can take. `Panel` means "start nothing", which is the
/// state the app OPENS in.
///
/// There is no `embed`: this app does not draw the shipped interface and does not
/// pretend to. The interface is a web application, the process that draws it is a
/// browser, and `browser.rs` is the table that finds one. `-Mode embed` is refused BY
/// NAME rather than quietly downgraded, because a flag that silently means something
/// else is a flag nobody can trust.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The control panel and nothing else. The harness is not started.
    Panel,
    /// The panel, with the harness UI opened in a browser this app chose.
    Chrome,
    /// No window at all: a supervisor and a log, for a server or a check.
    Headless,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::Panel => "panel",
            Mode::Chrome => "chrome",
            Mode::Headless => "headless",
        }
    }

    pub fn parse(value: &str) -> Result<Mode, String> {
        match value.to_ascii_lowercase().as_str() {
            "panel" => Ok(Mode::Panel),
            "chrome" | "browser" => Ok(Mode::Chrome),
            "headless" => Ok(Mode::Headless),
            // Named, so somebody who read an older plan learns why rather than
            // wondering whether they typed it wrong.
            "embed" | "pane" => Err(
                "-Mode embed is not a mode this app has: it draws no web view, on purpose. The harness UI opens in a browser - `-Mode chrome`, which is the default. See docs/PLAN-egui-shell.md"
                    .to_string(),
            ),
            other => Err(format!(
                "-Mode expects one of panel, chrome or headless - got '{other}'"
            )),
        }
    }

    /// The mode this build uses when no flag was given: `chrome`, which shows the
    /// harness in a browser and is what every launcher in this repository does.
    pub fn default_mode() -> Mode {
        Mode::Chrome
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

/// The flags this shell parses.
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Options {
    /// Explicit port; 0 means "pick a free one".
    pub port: u16,
    pub dsh_home: Option<String>,
    pub dsh_version: Option<String>,
    pub mode: Option<Mode>,
    pub help: bool,
}

impl Options {
    /// The mode this run will use.
    pub fn mode(&self) -> Mode {
        self.mode.unwrap_or_else(Mode::default_mode)
    }
}

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
            "-mode" | "--mode" => {
                options.mode = Some(Mode::parse(&next_value(&mut args, "-Mode")?)?)
            }
            "-help" | "--help" | "-h" | "/?" => options.help = true,
            other => {
                return Err(format!(
                    "unknown flag '{other}' - run scripts\\run-desktop.bat -Help for the accepted flags"
                ))
            }
        }
    }
    Ok(options)
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} needs a value after it"))
}

/// The usage text. One string, so the flags this shell accepts live in exactly one
/// place and `check-shell.mjs` can drive the binary and read it back.
pub const USAGE: &str = "\
Usage: scripts\\run-desktop.bat [flags]

  -Port <n>          listen on this port instead of a free one
  -DshHome <dir>     use this harness home instead of the one the app chose
                     (a leading ~ is expanded; a relative path is resolved here)
  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
  -Mode <mode>       chrome (the harness UI in a browser - the default),
                     panel (open idle and start nothing) or headless (no window)
  -Help              print this help

Opens on a control panel: nothing is started until you press Start, and Stop ends
the instance and frees its port. Start runs the same pinned harness, on the same
port and with the same flags as scripts\\run-web.bat - anything a browser tab can
do in that profile, this window can do, because it is the same server. There is no
embedded web view: the interface opens in a browser, and the panel offers Google
Chrome first when it is installed.

The app owns a root ($VNCODE_HOME) and the harness home is <root>/home inside it.
The panel shows which home is in use and why, offers to use or adopt an existing
harness home (~/.dsh), and installs the pack into the home it chose.

Install, Uninstall and Adopt in that panel run scripts/setup/install.*,
scripts/setup/uninstall.* and this app's own copy - the same files a person would
click.";

pub fn print_usage() {
    println!();
    println!("{USAGE}");
    println!();
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
    fn an_unknown_flag_is_refused_and_named() {
        // The failure this prevents: a typo silently becoming a default, so the
        // shell runs a different harness or a different port than the one asked
        // for and reports nothing.
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
        // 0 is the OS's "pick one for me"; the flag that means that is no flag at
        // all, because the shell prefers the harness's own default origin first.
        assert!(parse_args(args(&["-Port", "0"]))
            .unwrap_err()
            .contains("above zero"));
        assert!(parse_args(args(&["-Port", "seventy"]))
            .unwrap_err()
            .contains("port number"));
    }

    #[test]
    fn the_mode_flag_names_what_it_accepts_and_refuses_what_it_does_not() {
        assert_eq!(parse_args(args(&["-Mode", "chrome"])).unwrap().mode, Some(Mode::Chrome));
        assert_eq!(parse_args(args(&["-mode", "HEADLESS"])).unwrap().mode, Some(Mode::Headless));
        assert_eq!(parse_args(args(&["-Mode", "panel"])).unwrap().mode, Some(Mode::Panel));
        let error = parse_args(args(&["-Mode", "sideways"])).unwrap_err();
        assert!(error.contains("panel, chrome or headless"), "{error}");
        // `embed` is a mode this app does NOT have, and it says so by name rather
        // than quietly opening a browser and letting the reader think a pane exists.
        let error = parse_args(args(&["-Mode", "embed"])).unwrap_err();
        assert!(error.contains("draws no web view"), "{error}");
        assert!(error.contains("chrome"), "{error}");
    }

    #[test]
    fn the_launchers_flags_are_not_silently_swallowed() {
        // -NoPause/-NoTerminal/-NoBuild belong to the launcher and are stripped
        // there; reaching this parser means they were NOT stripped, and the shell
        // must say so rather than run with a flag it ignored.
        for flag in ["-NoPause", "-NoTerminal", "-NoBuild"] {
            assert!(parse_args(args(&[flag])).is_err(), "{flag} was accepted");
        }
    }

    #[test]
    fn the_usage_text_names_every_flag_the_parser_takes() {
        for flag in ["-Port", "-DshHome", "-DshVersion", "-Mode", "-Help"] {
            assert!(USAGE.contains(flag), "the usage text never mentions {flag}");
        }
    }

    #[test]
    fn the_default_mode_is_the_one_every_launcher_in_this_repository_uses() {
        // `chrome`: the harness UI in a browser. There is no pane to prefer, and no
        // platform on which the answer differs - which is what makes the flag set,
        // the launcher and the docs agree.
        assert_eq!(Mode::default_mode(), Mode::Chrome);
        let nothing_asked = Options::default();
        assert_eq!(nothing_asked.mode(), Mode::Chrome);
        // ...and an explicit flag always wins.
        let asked = Options { mode: Some(Mode::Headless), ..Options::default() };
        assert_eq!(asked.mode(), Mode::Headless);
        let idle = Options { mode: Some(Mode::Panel), ..Options::default() };
        assert_eq!(idle.mode(), Mode::Panel);
    }
}
