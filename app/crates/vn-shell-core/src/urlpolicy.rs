//! Which URLs this shell may load itself, and what happens to the rest.
//!
//! The rule is short and it is the whole reason the pane can be trusted with a
//! page: the shell navigates to the harness's own loopback URL and to nothing
//! else. A link clicked inside the rendered app goes to the reader's browser,
//! which is a different process with a different blast radius.

use std::process::{Command, Stdio};

use url::Url;

use crate::readyline::is_loopback_host;

/// Whether a URL may be loaded into this shell's own pane.
pub fn is_internal(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => match url.host_str() {
            Some(host) => is_loopback_host(host),
            None => false,
        },
        _ => false,
    }
}

/// The platform's own "open this URL" program, with the URL as ONE argv element.
///
/// `explorer.exe` is what the pack's `dsh-open-in-app` uses for the same job on
/// Windows; `open` and `xdg-open` are the macOS and Linux spellings. Returned as a
/// `Command` rather than run here, so a caller can start it - and a check can read
/// the argv - without a browser opening as a side effect of running the tests.
pub fn opener_command(url: &str) -> Command {
    let program = if cfg!(target_os = "windows") {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(program);
    command.arg(url);
    command
}

/// Open a URL in the platform's own browser, with argv only - never a shell.
///
/// The floor under `browser`: used when nothing in that table matched, and by any
/// caller that has no browser preference of its own.
pub fn open_external(url: &str) {
    if let Err(error) = opener_command(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        eprintln!("[vncode] could not open {url} in a browser: {error}");
    }
}

/// Open whatever holds a path: the folder itself, or the file's own folder.
///
/// The panel's "reveal" action. `explorer.exe /select,` is the Windows spelling;
/// `open -R` is macOS's; Linux has no portable "select", so the containing folder
/// is opened instead - which is a smaller promise, and the honest one.
pub fn reveal(path: &std::path::Path, is_dir: bool) {
    let (program, args): (&str, Vec<String>) = if cfg!(target_os = "windows") {
        if is_dir {
            ("explorer.exe", vec![path.display().to_string()])
        } else {
            ("explorer.exe", vec!["/select,".to_string(), path.display().to_string()])
        }
    } else if cfg!(target_os = "macos") {
        if is_dir {
            ("open", vec![path.display().to_string()])
        } else {
            ("open", vec!["-R".to_string(), path.display().to_string()])
        }
    } else {
        let folder = if is_dir {
            path.to_path_buf()
        } else {
            path.parent().map(|parent| parent.to_path_buf()).unwrap_or_else(|| path.to_path_buf())
        };
        ("xdg-open", vec![folder.display().to_string()])
    };
    if let Err(error) = Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        eprintln!("[vncode] could not reveal {}: {error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_opener_is_a_program_with_the_url_as_one_argument() {
        // The rule the launch path depends on: `explorer.exe`/`open`/`xdg-open` with
        // exactly one argument, and no shell in between.
        let command = opener_command("http://127.0.0.1:3080/?token=x");
        let args: Vec<String> =
            command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec!["http://127.0.0.1:3080/?token=x".to_string()]);
        let program = command.get_program().to_string_lossy().to_string();
        let expected = if cfg!(target_os = "windows") {
            "explorer.exe"
        } else if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        assert_eq!(program, expected);
    }

    #[test]
    fn loopback_is_internal_and_everything_else_is_not() {
        for allowed in ["http://127.0.0.1:3080/?token=x", "http://localhost:3080/", "https://[::1]:9/"] {
            let url = Url::parse(allowed).unwrap();
            assert!(is_internal(&url), "{allowed} should be loadable");
        }
        for refused in [
            "http://evil.example/?token=x",
            "https://127.0.0.1.evil.example/",
            "file:///etc/passwd",
            "tauri://localhost/index.html",
            "data:text/html,<h1>hi</h1>",
            "javascript:alert(1)",
        ] {
            let url = Url::parse(refused).unwrap();
            assert!(!is_internal(&url), "{refused} must never be loaded by the shell");
        }
    }

    #[test]
    fn only_http_and_https_over_loopback_may_be_loaded_by_the_shell() {
        // The scheme is part of the rule, not just the host: `ftp://127.0.0.1/`
        // names a loopback address and still has no business in the pane.
        for refused in ["ftp://127.0.0.1/", "ws://127.0.0.1:3080/", "file://127.0.0.1/x"] {
            let url = Url::parse(refused).unwrap();
            assert!(!is_internal(&url), "{refused} must never be loaded by the shell");
        }
    }
}
