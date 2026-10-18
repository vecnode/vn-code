//! What a person typed, turned into a path this app may actually use.
//!
//! `-DshHome`, `VNCODE_HOME` and a remembered home all arrive as TEXT, and a path
//! used without being cleaned is how an app writes somewhere it did not mean to -
//! or hands a child a path that means something different to the child than it did
//! to the parent. Four rules, applied in this order, and every one of them is a
//! `cargo test` case:
//!
//! 1. **A leading `~` is expanded against the user's home**, exactly as the harness
//!    expands it in `resolveDshHome`. Measured cost of not doing it: `-DshHome ~/x`
//!    became a directory literally named `~` in the current directory, which the app
//!    then proved writable and reported as the home.
//! 2. **A relative path is resolved against the directory the app was started in**,
//!    and the ABSOLUTE path is what gets exported, recorded and passed on - so the
//!    harness and the installer cannot disagree about it because one of them changed
//!    its working directory.
//! 3. **The path is normalised LEXICALLY**: `.` and `..` are folded without asking
//!    the filesystem. Two spellings of one home must not look like two homes.
//! 4. **The Windows verbatim form is never produced or kept.** `fs::canonicalize`
//!    answers `\\?\C:\…`, which breaks PowerShell, `cmd`, JSON consumers and some
//!    Node APIs; [`canonical`] strips it back to `C:\…`.
//!
//! An empty path and a path containing a NUL are refused by name: neither can be
//! handed to a child, and a NUL in particular reaches `CreateProcess`/`execvp` as a
//! truncated string, which is the classic way a path check is bypassed.

use std::path::{Component, Path, PathBuf};

/// Turn typed text into an absolute, lexically normalised path.
///
/// `cwd` is where a relative path is resolved against - the app captures it once, so
/// the answer does not depend on when this is called. A `~` with no known user home
/// is an error rather than a guess.
pub fn resolve(typed: &str, cwd: Option<&Path>, user_home: Option<&Path>) -> Result<PathBuf, String> {
    let trimmed = typed.trim();
    if trimmed.is_empty() {
        return Err("the path is empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("the path contains a NUL byte, which no process can be given".to_string());
    }
    let expanded = expand_home(trimmed, user_home)?;
    let absolute = if expanded.is_absolute() {
        expanded
    } else if expanded.has_root() {
        // Rooted but without a prefix: on Windows `/tmp/x` and `\tmp\x` mean "on the
        // current drive", so the drive comes from the directory the app started in -
        // which is the only way this can be one absolute path rather than a path that
        // means something different to each process that inherits it.
        match cwd.and_then(|cwd| cwd.components().next()) {
            Some(Component::Prefix(prefix)) => {
                let mut joined = prefix.as_os_str().to_os_string();
                joined.push(expanded.as_os_str());
                PathBuf::from(joined)
            }
            // POSIX, or a working directory that is itself just a root: the path is
            // already as absolute as this platform gets.
            _ => expanded,
        }
    } else {
        let cwd = cwd.ok_or_else(|| {
            format!(
                "'{trimmed}' is relative and this app could not read the directory it was started in"
            )
        })?;
        cwd.join(expanded)
    };
    Ok(normalise(&absolute))
}

/// Expand a leading `~` (alone, or followed by a separator) against the user's home.
///
/// The harness's own rule, so `-DshHome ~/harness` means the same thing to the app,
/// to the harness and to the installer.
pub fn expand_home(typed: &str, user_home: Option<&Path>) -> Result<PathBuf, String> {
    let rest = if typed == "~" {
        Some("")
    } else {
        typed.strip_prefix("~/").or_else(|| typed.strip_prefix("~\\"))
    };
    match rest {
        Some("") => user_home
            .map(Path::to_path_buf)
            .ok_or_else(|| "the path is '~' and this app could not resolve the user's home".to_string()),
        Some(rest) => {
            let home = user_home.ok_or_else(|| {
                "the path starts with '~' and this app could not resolve the user's home".to_string()
            })?;
            Ok(home.join(rest))
        }
        None => Ok(PathBuf::from(typed)),
    }
}

/// Fold `.` and `..` without touching the filesystem.
///
/// Lexical on purpose: resolving symlinks is [`canonical`]'s job, and a `..` that is
/// lexically foldable must not depend on whether the directory happens to exist yet.
pub fn normalise(path: &Path) -> PathBuf {
    let path = strip_verbatim(path);
    let mut out: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                // `a/b/..` is `a`.
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // `../a` keeps its `..`: there is nothing above it to fold.
                Some(Component::ParentDir) | None => out.push(component),
                // A `..` at a root is a no-op (`/..` is `/`).
                _ => {}
            },
            other => out.push(other),
        }
    }
    let normalised: PathBuf = out.iter().collect();
    if normalised.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalised
    }
}

/// The real path, once it exists, with the Windows verbatim prefix removed.
///
/// Falls back to the lexically normalised path when the filesystem cannot answer
/// (the directory does not exist yet, a permission the app does not have). The
/// fallback is not a failure: this app decides where to write by PROBING, and the
/// path it exports only has to be one the child can use.
pub fn canonical(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(real) => strip_verbatim(&real),
        Err(_) => normalise(path),
    }
}

/// Drop the Windows verbatim prefix: `\\?\C:\x` becomes `C:\x`, `\\?\UNC\s\v`
/// becomes `\\s\v`, and anything else is returned unchanged.
///
/// Not cosmetic: the verbatim form is rejected by PowerShell in some positions, is
/// echoed into `cmd` as garbage, and is a different string to every consumer that
/// compares paths textually - including this pack's own checks.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// Whether a path is worth writing a probe into at all - the cheap refusals, before
/// the filesystem is asked anything.
pub fn is_plausible(path: &Path) -> bool {
    !path.as_os_str().is_empty() && !path.to_string_lossy().contains('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\someone")
        } else {
            PathBuf::from("/home/someone")
        }
    }

    #[test]
    fn a_tilde_is_expanded_exactly_where_the_harness_expands_it() {
        let home = home();
        assert_eq!(resolve("~", None, Some(&home)).unwrap(), home);
        assert_eq!(resolve("~/harness", None, Some(&home)).unwrap(), home.join("harness"));
        // A `~` that is not the whole first component is an ordinary NAME, not an
        // expansion: `~someone` is a directory somebody made, and it stays relative.
        let cwd = home.join("work");
        let named = resolve("~someone/x", Some(&cwd), Some(&home)).unwrap();
        assert_eq!(named, cwd.join("~someone").join("x"));
        // `~` with no resolvable home is refused rather than guessed.
        assert!(resolve("~/x", None, None).is_err());
        assert!(resolve("~", None, None).is_err());
    }

    #[test]
    fn a_rooted_path_without_a_drive_is_attached_to_the_current_drive() {
        // Windows: `/tmp/x` is rooted on the CURRENT DRIVE, and it has to become one
        // absolute path before it is exported - a child that inherits a bare
        // `\tmp\x` resolves it against ITS own drive and working directory.
        let cwd = if cfg!(windows) { PathBuf::from(r"C:\here") } else { PathBuf::from("/here") };
        let resolved = resolve("/tmp/x", Some(&cwd), None).unwrap();
        assert!(resolved.is_absolute(), "{}", resolved.display());
        let text = resolved.to_string_lossy().replace('\\', "/");
        assert!(text.ends_with("/tmp/x"), "{text}");
        if cfg!(windows) {
            assert!(text.starts_with("C:/"), "the drive must come from the cwd: {text}");
        }
    }

    #[test]
    fn a_relative_path_is_resolved_against_the_directory_the_app_started_in() {
        let cwd = if cfg!(windows) { PathBuf::from(r"C:\here") } else { PathBuf::from("/here") };
        let resolved = resolve("sub/home", Some(&cwd), None).unwrap();
        assert!(resolved.is_absolute(), "{}", resolved.display());
        assert_eq!(resolved, cwd.join("sub").join("home"));
        // ...and with no cwd known, it is a refusal rather than a silent guess.
        let error = resolve("sub/home", None, None).unwrap_err();
        assert!(error.contains("relative"), "{error}");
    }

    #[test]
    fn dots_are_folded_without_touching_the_filesystem() {
        let start = if cfg!(windows) { PathBuf::from(r"C:\a") } else { PathBuf::from("/a") };
        assert_eq!(normalise(&start.join("b").join("..")), start);
        assert_eq!(
            normalise(&start.join("b").join(".").join("c")),
            start.join("b").join("c")
        );
        // A `..` with nothing above it keeps its meaning.
        let leading = normalise(Path::new("../a"));
        assert!(leading.starts_with(".."), "{}", leading.display());
        // ...and an absolute `..` at the root is a no-op, not an escape.
        let rooted = normalise(Path::new(if cfg!(windows) { r"C:\.." } else { "/.." }));
        assert!(!rooted.to_string_lossy().contains(".."), "{}", rooted.display());
    }

    #[test]
    fn the_windows_verbatim_form_is_stripped() {
        // Whatever canonicalize answers on Windows must never reach a child: cmd,
        // PowerShell, JSON consumers and this pack's own checks all disagree with it.
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\x\y")), PathBuf::from(r"C:\x\y"));
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\server\share\x")), PathBuf::from(r"\\server\share\x"));
        assert_eq!(strip_verbatim(Path::new("/plain/path")), PathBuf::from("/plain/path"));
        // A real path that already exists canonicalizes to itself (never verbatim).
        let here = std::env::current_dir().unwrap();
        let real = canonical(&here);
        assert!(!real.to_string_lossy().starts_with(r"\\?\"), "{}", real.display());
    }

    #[test]
    fn an_empty_path_and_a_nul_are_refused_by_name() {
        let error = resolve("   ", None, None).unwrap_err();
        assert!(error.contains("empty"), "{error}");
        let error = resolve("a\0b", None, None).unwrap_err();
        assert!(error.contains("NUL"), "{error}");
        assert!(!is_plausible(Path::new("")));
        assert!(!is_plausible(Path::new("a\0b")));
        assert!(is_plausible(Path::new("/a")));
    }

    #[test]
    fn canonical_of_something_that_does_not_exist_is_still_a_usable_path() {
        let missing = if cfg!(windows) {
            PathBuf::from(r"C:\definitely\not\here\at\all")
        } else {
            PathBuf::from("/definitely/not/here/at/all")
        };
        let answer = canonical(&missing);
        assert!(answer.is_absolute(), "{}", answer.display());
        assert!(!answer.to_string_lossy().contains(".."));
    }
}
