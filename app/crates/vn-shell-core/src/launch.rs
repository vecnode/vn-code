//! What gets run: the pin, the vendored runtime, and the exact argv.
//!
//! This is where the failure that made the app look like it needed Administrator
//! was fixed, so the rules here are load-bearing rather than tidy:
//!
//! `npx` writes into an npm cache, and on the machine this was written on that
//! cache was owned by an elevated run, so starting the app produced `npm error
//! code EPERM` and npm's own message told the reader to run as Administrator -
//! which makes the ownership problem worse. Nothing about that is a defect in
//! this shell and it cannot be repaired from inside it: the fix is to stop
//! invoking npm to START an application. `scripts/tools/vendor.ps1` resolves the
//! pinned harness once, at BUILD time, into
//!
//! ```text
//! runtime/<rid>/node/node[.exe]
//! runtime/<rid>/harness/node_modules/@deepseek-ai/dsh/lib/bin.js
//! ```
//!
//! and this shell launches that pair directly: no npm, no registry, no network
//! and no cache to be denied. The only path npm still appears on is the fallback
//! a source checkout takes when nobody has vendored the runtime yet.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::options::Options;

/// The profile this shell starts, and the one every surface names.
///
/// `dsh web` and `dsh --profile web` are the SAME profile: `web` is the alias the
/// pin's CLI documents, and it is the pack's one install target. It lives here, in
/// the pure crate, because three places need to agree about it - the supervisor's
/// launch, the prefs reader and the panel's "is the pack installed" row.
pub const PROFILE: &str = "web";

/// The package the pinned harness installs under, as `npx` spells it.
///
/// One constant, because two places name it: the `npx` fallback's argv below, and
/// the launch line the panel and the log print.
pub const PACKAGE: &str = "@deepseek-ai/dsh";

/// The runtime identifier directory name, matching `scripts/tools/vendor.ps1`.
pub fn host_rid() -> &'static str {
    if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") {
            "win-arm64"
        } else if cfg!(target_arch = "x86") {
            "win-ia32"
        } else {
            "win-x64"
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x64"
    }
}

/// How this launch will start the harness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Launch {
    /// A vendored runtime: run this Node on this bin.js. No package manager.
    Vendored { node: PathBuf, bin: PathBuf },
    /// The harness this machine ALREADY has, run with the Node on PATH.
    ///
    /// The pack's profile live-links `@deepseek-ai/dsh` out of the npm/npx cache, so
    /// where the pack is installed the harness is already on disk - it is the
    /// installation a browser tab is running right now. Starting it from here needs
    /// no npm, no network and no writable cache, which matters because npm is the
    /// one part of this path that can fail for reasons that have nothing to do with
    /// this application: a cache an elevated run made unwritable, a machine where an
    /// administrator has to be asked, a network that is not there.
    Installed { node: PathBuf, bin: PathBuf },
    /// Nothing local, so fall back to `npx <spec> web`.
    Npx,
    /// The test seam: run this program instead of the harness.
    ///
    /// Reached only through `VNCODE_STUB_CLI` / `VNCODE_STUB_ARGS`, which the
    /// shipped launchers never set. It exists so `scripts/checks/check-shell.mjs`
    /// can drive the REAL supervisor - the ready-line watch, the refusals, the
    /// token rule and Stop - without a harness on the machine, which is the
    /// difference between a check that proves behaviour and a check that greps
    /// source. `args` is the prefix, so the check can name an INTERPRETER and a
    /// script (`node stub.mjs`), which is what makes the seam work on all three
    /// platforms without an executable bit.
    Stub { program: PathBuf, args: Vec<String> },
}

impl Launch {
    pub fn kind(&self) -> &'static str {
        match self {
            Launch::Vendored { .. } => "vendored runtime",
            Launch::Installed { .. } => "the installation this machine already has",
            Launch::Npx => "npx fallback",
            Launch::Stub { .. } => "stub (test seam)",
        }
    }
}

/// The program and argv, as data, so the launch decision is testable without
/// spawning anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub program: OsString,
    pub args: Vec<OsString>,
}

/// `npx.cmd` on Windows, `npx` elsewhere.
///
/// std runs a batch file through `cmd.exe` itself, and the spec/flag values here
/// are plain enough that nothing in them can be read as a shell metacharacter.
pub fn npx_program() -> &'static str {
    if cfg!(target_os = "windows") {
        "npx.cmd"
    } else {
        "npx"
    }
}

/// The exact argv for a launch: `web --no-open --port N`, and for npx the
/// package spec in front of it.
pub fn program_and_args(launch: &Launch, version: &str, port: u16) -> Command {
    let port = port.to_string();
    match launch {
        // Both of these run a real Node on a real bin.js: one is the copy this
        // application vendored, the other is the copy already on this machine. The
        // argv is identical because the harness does not care which it is.
        Launch::Vendored { node, bin } | Launch::Installed { node, bin } => Command {
            program: node.clone().into_os_string(),
            args: vec![
                bin.clone().into_os_string(),
                "web".into(),
                "--no-open".into(),
                "--port".into(),
                port.into(),
            ],
        },
        Launch::Npx => Command {
            program: npx_program().into(),
            args: vec![
                "--yes".into(),
                format!("{PACKAGE}@{version}").into(),
                "web".into(),
                "--no-open".into(),
                "--port".into(),
                port.into(),
            ],
        },
        Launch::Stub { program, args } => {
            let mut full = args.iter().map(OsString::from).collect::<Vec<_>>();
            full.extend([
                OsString::from("web"),
                OsString::from("--no-open"),
                OsString::from("--port"),
                OsString::from(port),
            ]);
            Command { program: program.clone().into_os_string(), args: full }
        }
    }
}

/// Resolve the vendored runtime, if one is complete.
///
/// Complete means all THREE pieces exist - the Node, the harness entry point and
/// the stamp. A half-copied runtime must not be chosen, because the shell would
/// then fail to start the harness and report a broken install rather than falling
/// back to the path that works. The stamp is what `scripts/tools/vendor.ps1` writes
/// LAST, after it has run the pair and watched it report a version, so its
/// presence is a claim this shell can trust.
pub fn vendored_runtime(root: &Path) -> Option<Launch> {
    let runtime = root.join("runtime").join(host_rid());
    let node_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
    let node = runtime.join("node").join(node_name);
    let bin = runtime
        .join("harness")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !node.is_file() || !bin.is_file() || !runtime.join("VENDOR.json").is_file() {
        return None;
    }
    Some(Launch::Vendored { node, bin })
}

/// The package name the harness installs under, and the entry point inside it.
fn harness_in(directory: &Path) -> Option<PathBuf> {
    let dsh = directory.join("@deepseek-ai").join("dsh");
    let bin = dsh.join("lib").join("bin.js");
    if !bin.is_file() {
        return None;
    }
    Some(dsh)
}

/// Every place a previously installed harness might be, best candidate first.
///
/// The profile's own link is first because it is EXACTLY the installation a browser
/// tab runs: `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` is a junction into
/// the npm cache, so following it cannot pick a different harness than the one this
/// machine is already using. The `_npx` scan behind it is for a machine where the
/// profile has not been linked yet (or was reinstalled from elsewhere).
pub fn installed_candidates(home: Option<&Path>, cache_root: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = home {
        candidates.push(home.join("profiles").join("node_modules"));
    }
    if let Some(cache_root) = cache_root {
        let npx = cache_root.join("_npx");
        if let Ok(entries) = std::fs::read_dir(&npx) {
            let mut found: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("node_modules"))
                .filter(|path| path.is_dir())
                .collect();
            // Sorted, so two runs on one machine make the same choice.
            found.sort();
            candidates.extend(found);
        }
    }
    candidates
}

/// The version a harness installation reports, if it says.
fn installed_version(dsh: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dsh.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// The harness this machine already has, at the pinned version - and how to run it
/// without npm.
///
/// `version` is the pin, and it is a REQUIREMENT rather than a preference: a machine
/// can have several harness installations in its cache (this one has four), and
/// starting the wrong one would be a shell that quietly runs a different harness
/// than `scripts\run-web.bat` does. An installation whose `package.json` names
/// another version is skipped, and the search continues.
pub fn installed_harness_in(
    home: Option<&Path>,
    cache_root: Option<&Path>,
    version: &str,
) -> Option<Launch> {
    for directory in installed_candidates(home, cache_root) {
        let Some(dsh) = harness_in(&directory) else {
            continue;
        };
        if installed_version(&dsh).as_deref() != Some(version) {
            continue;
        }
        return Some(Launch::Installed {
            // The Node on PATH: this is the machine's own installation, so it is the
            // machine's own Node that runs it, exactly as an `npx` run would.
            node: PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }),
            bin: dsh.join("lib").join("bin.js"),
        });
    }
    None
}

/// [`installed_harness_in`], against this machine's own npm cache.
pub fn installed_harness(home: Option<&Path>, version: &str) -> Option<Launch> {
    installed_harness_in(home, crate::appdata::npx_cache_root().as_deref(), version)
}

/// The test seam, read from the environment.
///
/// Environment variables rather than flags on purpose: they must not widen the
/// flag set the three launchers share, and nothing a user types can reach them by
/// accident. `VNCODE_STUB_CLI` names the program and `VNCODE_STUB_ARGS` is an
/// optional JSON array of arguments in front of the CLI's own (which is how the
/// check runs `node <stub.mjs> web --no-open --port N`). A path that does not
/// exist is ignored with a loud line, so a stale value in a shell profile cannot
/// make the app silently do nothing.
pub fn stub_from_env() -> Option<(PathBuf, Vec<String>)> {
    let value = std::env::var("VNCODE_STUB_CLI").ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    if !path.is_file() {
        eprintln!(
            "[vncode] VNCODE_STUB_CLI names {} which is not a file; launching the real harness instead.",
            path.display()
        );
        return None;
    }
    let args = std::env::var("VNCODE_STUB_ARGS")
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();
    eprintln!(
        "[vncode] TEST SEAM: running {} instead of the harness (VNCODE_STUB_CLI is set).",
        path.display()
    );
    Some((path, args))
}

/// Decide how to launch, best first.
///
/// 1. The test seam, if a check set it.
/// 2. The VENDORED runtime - its own Node, checksum-verified, no npm anywhere.
/// 3. The harness this machine ALREADY has at the pin, run with the Node on PATH.
///    This is the rung that matters when npm itself is broken: no cache to write,
///    no network, no package manager.
/// 4. `npx`, the last resort.
pub fn choose_launch(root: Option<&Path>, home: Option<&Path>, version: &str) -> Launch {
    if let Some((program, args)) = stub_from_env() {
        return Launch::Stub { program, args };
    }
    if let Some(vendored) = root.and_then(vendored_runtime) {
        return vendored;
    }
    installed_harness(home, version).unwrap_or(Launch::Npx)
}

// ---------------------------------------------------------------------------
// The repository root and the pin
// ---------------------------------------------------------------------------
/// Find the repository root by walking up from this executable looking for
/// `.dsh-version.json`.
///
/// Walking beats counting directories: the build might be `target/release`,
/// `target/debug`, or a `CARGO_TARGET_DIR` somewhere else entirely, and all three
/// must land on the same root. With a workspace the binary lands one level
/// deeper, which is exactly why this walks rather than counts.
pub fn repo_root() -> Option<PathBuf> {
    let mut directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..8 {
        if directory.join(".dsh-version.json").is_file() {
            return Some(directory);
        }
        directory = directory.parent()?.to_path_buf();
    }
    None
}

/// The pinned dsh version: the flag wins, then `.dsh-version.json`.
///
/// There is deliberately NO built-in fallback. A stale hard-coded pin would mean a
/// shell that quietly runs a different harness than `scripts\run-web.bat`, so an
/// unreadable manifest is an error that names the file.
pub fn resolve_version(options: &Options) -> Result<String, String> {
    resolve_version_with(options, repo_root().as_deref())
}

/// The pure half of [`resolve_version`], so the pin rule is testable without a
/// checkout at a fixed path.
pub fn resolve_version_with(options: &Options, root: Option<&Path>) -> Result<String, String> {
    if let Some(version) = options.dsh_version.as_ref().filter(|value| !value.is_empty()) {
        return Ok(version.clone());
    }
    let root = root.ok_or_else(|| {
        "could not find .dsh-version.json in this folder or any folder above it - run the shell from inside the vncode repository, or pass -DshVersion <ver>".to_string()
    })?;
    let manifest = root.join(".dsh-version.json");
    let text = std::fs::read_to_string(&manifest)
        .map_err(|error| format!("could not read {}: {error}", manifest.display()))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", manifest.display()))?;
    json.get("dsh")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| format!("{} has no \"dsh\" version pin", manifest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(command: &Command) -> Vec<String> {
        command
            .args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn the_vendored_launch_runs_node_on_bin_js_with_the_same_flags_as_run_web() {
        let launch = Launch::Vendored {
            node: PathBuf::from("/rt/node/node"),
            bin: PathBuf::from("/rt/harness/bin.js"),
        };
        let command = program_and_args(&launch, "0.2.0-rc.2", 3080);
        assert_eq!(command.program, OsString::from("/rt/node/node"));
        assert_eq!(
            strings(&command),
            vec!["/rt/harness/bin.js", "web", "--no-open", "--port", "3080"]
        );
    }

    #[test]
    fn the_npx_fallback_carries_the_pin_and_the_same_flags() {
        let command = program_and_args(&Launch::Npx, "0.2.0-rc.2", 3099);
        assert_eq!(command.program, OsString::from(npx_program()));
        assert_eq!(
            strings(&command),
            vec![
                "--yes",
                "@deepseek-ai/dsh@0.2.0-rc.2",
                "web",
                "--no-open",
                "--port",
                "3099"
            ]
        );
    }

    #[test]
    fn the_stub_seam_is_given_the_shapes_the_harness_would_see() {
        // So a stub can behave like the CLI - including the ready line - without
        // the check having to know which launch branch was taken. The prefix is
        // what lets the seam name an interpreter, which is how it works on
        // Windows without an executable bit.
        let launch = Launch::Stub {
            program: PathBuf::from("/usr/bin/node"),
            args: vec!["/tmp/stub.mjs".to_string()],
        };
        let command = program_and_args(&launch, "0.2.0-rc.2", 1234);
        assert_eq!(command.program, OsString::from("/usr/bin/node"));
        assert_eq!(
            strings(&command),
            vec!["/tmp/stub.mjs", "web", "--no-open", "--port", "1234"]
        );
    }

    #[test]
    fn a_half_vendored_runtime_is_not_chosen() {
        // The stamp is written LAST by vendor.ps1, after it has run the pair, so
        // a runtime without it is a runtime nobody has proved.
        let root = crate::scratch::dir("half-vendored");
        let runtime = root.join("runtime").join(host_rid());
        std::fs::create_dir_all(runtime.join("node")).unwrap();
        std::fs::create_dir_all(runtime.join("harness").join("node_modules")).unwrap();
        let node_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
        std::fs::write(runtime.join("node").join(node_name), b"x").unwrap();
        assert!(vendored_runtime(&root).is_none(), "an unproved runtime was chosen");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pin_comes_from_the_flag_before_the_manifest() {
        let options = Options { dsh_version: Some("9.9.9".into()), ..Options::default() };
        assert_eq!(resolve_version_with(&options, None).unwrap(), "9.9.9");
    }

    #[test]
    fn an_unreadable_pin_is_an_error_that_names_the_file() {
        let options = Options::default();
        let error = resolve_version_with(&options, None).unwrap_err();
        assert!(error.contains(".dsh-version.json"), "{error}");

        let empty = crate::scratch::dir("pin");
        std::fs::create_dir_all(&empty).unwrap();
        let error = resolve_version_with(&options, Some(&empty)).unwrap_err();
        assert!(error.contains("could not read"), "{error}");
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn the_pin_is_read_out_of_the_manifest_this_repository_ships() {
        // The real manifest, found by walking up from the test binary - which is
        // the same walk the shell does at run time, one directory deeper.
        let root = repo_root().expect("the test binary is not inside a vncode checkout");
        let options = Options::default();
        let version = resolve_version_with(&options, Some(&root)).unwrap();
        assert!(!version.is_empty());
        assert!(version.starts_with("0."), "unexpected pin {version}");
    }
}
