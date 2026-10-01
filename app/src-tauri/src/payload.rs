//! The self-extracting payload: a whole distribution appended to this binary.
//!
//! A distribution is normally a FOLDER - `packages/` is live-linked by the web
//! profile, so the folder is the application and `vncode.exe` is just the
//! window onto it. Handing somebody one file to double-click cannot change that
//! (a live link needs a real directory that stays put), so the single-file build
//! does the only thing that can work: it carries the folder INSIDE itself,
//! unpacks it once into a stable per-user directory, and then does exactly what
//! `START-HERE` does from an unpacked folder.
//!
//! This module is the unpacking half. It never decides to install anything, and
//! it never opens a window: the shell still only runs, and the installer still
//! only installs.
//!
//! # The container
//!
//! ```text
//! [ this executable's own bytes ]
//! [ the distribution zip        ]   zip_start, zip_len
//! [ trailer JSON (utf-8)        ]   trailer_len
//! [ trailer_len as u64 LE       ]
//! [ magic 8                     ]   the last 8 bytes of the file
//! ```
//!
//! The trailer is the whole reason there is no signature scan: the zip needs no
//! search from the end of the file, and the exe's own bytes can contain anything
//! at all - including, on a machine that has one, another zip. A file that does
//! NOT end with [`MAGIC`] is simply not a single-file build, which is every
//! `vncode.exe` built into a distribution folder and every `cargo run`.
//!
//! # The rules
//!
//! 1. **Nothing is unpacked until the payload is verified as far as it can be.**
//!    The trailer parses, `zip_start`/`zip_len` fall inside the file, and every
//!    central-directory entry is read before a single byte is written.
//! 2. **An unpack is ALL OR NOTHING, and it is never half-visible.** Entries are
//!    written into a staging directory beside the real one and the directory is
//!    renamed into place only after the last file is written, so a run that dies
//!    mid-extract leaves the previous unpack untouched and the next run simply
//!    tries again.
//! 3. **The unpack directory is keyed on the payload's identity**
//!    (`<version>-<rid>`), so a second double-click reuses it, and a newer
//!    release unpacks BESIDE the old one instead of overwriting a folder whose
//!    binaries may be running. The `START-HERE` that follows re-points the live
//!    links at the new folder, which is the same thing running a new folder's
//!    `START-HERE` does by hand.
//! 4. **Every entry name is resolved as a relative path and refused if it is
//!    not.** An absolute name, a `..` component, a drive letter or a backslash
//!    path is rejected rather than sanitised - a zip is data, and this one is
//!    read from a file the user was handed.
//! 5. **A file's bytes are checked against the zip's own CRC-32 and length.**
//!    A truncated download or a mangled payload fails loudly here instead of
//!    producing a folder that is missing one plugin and boots anyway.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process;

use flate2::read::DeflateDecoder;

/// The last eight bytes of a single-file build. The trailing `01` is the
/// CONTAINER version, so a future layout can be recognised and refused by name
/// rather than misread as this one.
const MAGIC: &[u8; 8] = b"VNHRNS01";

/// The little-endian `u64` length of the trailer JSON, then `MAGIC`: the last
/// sixteen bytes of a single-file build - so the file ENDS with the magic.
const TAIL_LEN: u64 = 16;

/// Written into the unpack directory once every entry is in place. Its content
/// is the payload's identity, so a directory left by a DIFFERENT payload (or by
/// an interrupted one) is never mistaken for this one's.
const MARKER: &str = ".vncode-payload";

/// The most a trailer may be. It is read in full before anything else happens,
/// so a corrupt length could otherwise ask for a gigabyte of allocation.
const TRAILER_MAX: u64 = 64 * 1024;

/// What the trailer says about the payload it precedes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trailer {
    /// The pack version, e.g. `0.1.1`.
    pub version: String,
    /// The target, e.g. `win-x64` - part of the unpack path, because two
    /// targets on one machine must not share a directory.
    pub rid: String,
    /// Where the zip starts, counted from the beginning of the executable.
    pub zip_start: u64,
    /// How long the zip is.
    pub zip_len: u64,
}

impl Trailer {
    /// The identity the unpack directory and its marker are keyed on.
    fn identity(&self) -> String {
        format!("{}-{}", self.version, self.rid)
    }
}

// ---------------------------------------------------------------------------
// Finding the payload
// ---------------------------------------------------------------------------

/// Read the trailer from `exe`.
///
/// `Ok(None)` is the ordinary answer and not a failure: it means this is a
/// shell built into a folder, which has no payload and needs none. `Err` is a
/// file that SAYS it is a single-file build and then cannot be read as one -
/// a truncated download, a version of the container this shell does not know -
/// and it is an error rather than a `None` so that it cannot be silently
/// downgraded into "no folder found either".
pub fn read_trailer(exe: &Path) -> Result<Option<Trailer>, String> {
    let mut file = File::open(exe).map_err(|error| format!("could not open {}: {error}", exe.display()))?;
    let length = file
        .metadata()
        .map_err(|error| format!("could not measure {}: {error}", exe.display()))?
        .len();
    if length < TAIL_LEN {
        return Ok(None);
    }

    let mut tail = [0u8; TAIL_LEN as usize];
    file.seek(SeekFrom::Start(length - TAIL_LEN))
        .map_err(|error| format!("could not read the payload trailer of {}: {error}", exe.display()))?;
    file.read_exact(&mut tail)
        .map_err(|error| format!("could not read the payload trailer of {}: {error}", exe.display()))?;
    if &tail[8..] != MAGIC {
        return Ok(None);
    }

    let mut length_bytes = [0u8; 8];
    length_bytes.copy_from_slice(&tail[..8]);
    let trailer_len = u64::from_le_bytes(length_bytes);
    if trailer_len == 0 || trailer_len > TRAILER_MAX || trailer_len + TAIL_LEN > length {
        return Err(format!(
            "{} ends with a payload trailer claiming {trailer_len} bytes of JSON, which cannot be right",
            exe.display()
        ));
    }

    let mut json = vec![0u8; trailer_len as usize];
    file.seek(SeekFrom::Start(length - TAIL_LEN - trailer_len))
        .map_err(|error| format!("could not read the payload trailer of {}: {error}", exe.display()))?;
    file.read_exact(&mut json)
        .map_err(|error| format!("could not read the payload trailer of {}: {error}", exe.display()))?;

    let trailer = parse_trailer(&String::from_utf8_lossy(&json))?;
    if trailer.zip_start + trailer.zip_len + TAIL_LEN + trailer_len > length {
        return Err(format!(
            "the payload trailer of {} points at bytes past the end of the file",
            exe.display()
        ));
    }
    Ok(Some(trailer))
}

/// The trailer's JSON, parsed and validated. Pure, so the container format is
/// tested without building an executable.
pub fn parse_trailer(json: &str) -> Result<Trailer, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("the payload trailer is not valid JSON: {error}"))?;
    let text = |key: &str| -> Result<String, String> {
        value
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .ok_or_else(|| format!("the payload trailer has no \"{key}\""))
    };
    let number = |key: &str| -> Result<u64, String> {
        value
            .get(key)
            .and_then(|value| value.as_u64())
            .ok_or_else(|| format!("the payload trailer has no \"{key}\""))
    };
    let trailer = Trailer {
        version: text("version")?,
        rid: text("rid")?,
        zip_start: number("zipStart")?,
        zip_len: number("zipLen")?,
    };
    if trailer.zip_len == 0 {
        return Err("the payload trailer describes an empty payload".to_string());
    }
    // The identity becomes a directory name, so it may not walk anywhere.
    for part in trailer.identity().split(|c: char| c == '/' || c == '\\') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return Err(format!(
                "the payload trailer's version/rid would not make a safe folder name: {}-{}",
                trailer.version, trailer.rid
            ));
        }
    }
    Ok(trailer)
}

/// Where a payload unpacks to on this machine.
///
/// The OS's own per-user data directory, NOT `$DSH_HOME`: this is the
/// application's own copy of itself, not the harness's state, and it must
/// survive a `-DshHome` that points somewhere unusual.
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

/// The directory one payload unpacks into. Pure: the path is a decision, and a
/// decision this shell makes once per launch is worth pinning.
pub fn payload_dir(data_root: &Path, trailer: &Trailer) -> PathBuf {
    data_root.join("vncode").join(trailer.identity())
}

/// The npm cache THIS application uses, deliberately not the machine's shared one.
///
/// WHY THIS EXISTS, because it is not tidiness. `npx` writes to
/// `%LOCALAPPDATA%\npm-cache` by default, and that directory is a shared,
/// machine-wide resource that other tooling - and an ELEVATED run of anything,
/// this shell included - also writes to. Measured on the machine this was
/// written on: after one run "as Administrator", twelve files inside that cache
/// were owned by `BUILTIN\Administrators` rather than the signed-in user, and the
/// next ordinary (non-elevated) run failed with
///
///     npm error code EPERM
///     npm error path ...\npm-cache\_cacache\tmp\7493d7c0
///     npm error Log files were not written due to an error writing to the
///     directory: ...\npm-cache\_logs
///
/// which is a permission failure the reader is told to fix by running as
/// Administrator - the wrong lesson twice over: this shell never needs elevation,
/// and taking that advice makes the problem worse by writing MORE files as the
/// elevated account.
///
/// Pointing the cache at this application's own directory removes the shared
/// resource from the equation: the bytes are written under the application's own
/// root, by the account actually running it, and a cache left behind by an
/// elevated run somewhere else cannot poison an ordinary one. It also keeps the
/// cache prunable with the rest of the application's data.
///
/// It lives BESIDE the unpacked payload rather than inside it, because the
/// unpack directory is keyed on the payload's identity: a new version unpacks
/// into a new directory, and a cache inside the old one would be abandoned on
/// every update.
pub fn npm_cache_dir(data_root: &Path) -> PathBuf {
    data_root.join("vncode").join("npm-cache")
}

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

/// Whether `dir` already holds THIS payload, unpacked.
///
/// The marker is the answer and the file's CONTENT is the check: a directory
/// left by a different payload, or by an interrupted unpack, has no marker or
/// somebody else's, and is unpacked over rather than trusted.
pub fn is_extracted(dir: &Path, trailer: &Trailer) -> bool {
    fs::read_to_string(dir.join(MARKER))
        .map(|text| text.trim() == trailer.identity())
        .unwrap_or(false)
}

/// Unpack `exe`'s payload into `dir`, or return immediately when `dir` is
/// already this exact payload's unpacked copy.
///
/// Returns the directory that now holds an unpacked distribution - the folder
/// whose `START-HERE` the caller hands off to.
pub fn ensure_extracted(exe: &Path, trailer: &Trailer, dir: &Path) -> Result<PathBuf, String> {
    if is_extracted(dir, trailer) {
        return Ok(dir.to_path_buf());
    }

    let mut file = File::open(exe).map_err(|error| format!("could not open {}: {error}", exe.display()))?;
    let mut bytes = vec![0u8; trailer.zip_len as usize];
    file.seek(SeekFrom::Start(trailer.zip_start))
        .map_err(|error| format!("could not read the payload of {}: {error}", exe.display()))?;
    file.read_exact(&mut bytes)
        .map_err(|error| format!("could not read the payload of {}: {error}", exe.display()))?;

    // Every entry is read and checked BEFORE anything is written, so a payload
    // this build cannot honour costs the user a message and not a half-folder.
    let entries = read_zip(&bytes)?;

    let parent = dir
        .parent()
        .ok_or_else(|| format!("{} has no parent directory to unpack into", dir.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("could not create {}: {error}", parent.display()))?;

    let staging = parent.join(format!(
        "{}.unpacking-{}",
        dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "payload".to_string()),
        process::id()
    ));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| format!("could not create {}: {error}", staging.display()))?;

    // From here on a failure must not leave the staging directory behind.
    let unpacked = write_entries(&bytes, &entries, &staging)
        .and_then(|()| fs::write(staging.join(MARKER), trailer.identity()).map_err(|error| format!("could not write the payload marker: {error}")));
    if let Err(message) = unpacked {
        let _ = fs::remove_dir_all(&staging);
        return Err(message);
    }

    // The old directory is replaced only now. A running app from the previous
    // unpack holds its binary open, and on Windows that is a locked file - so
    // the rename is reported rather than assumed.
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|error| {
            format!(
                "could not replace {} ({error}) - close any running vncode window and try again",
                dir.display()
            )
        })?;
    }
    fs::rename(&staging, dir).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        format!("could not move the unpacked payload into {}: {error}", dir.display())
    })?;
    Ok(dir.to_path_buf())
}

/// One file of the payload, as the central directory describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    name: String,
    method: u16,
    crc: u32,
    compressed: usize,
    uncompressed: usize,
    local_header: usize,
    /// The zip's own record of the unix permission bits, or 0 when the
    /// archiver stored none (which is what Windows' own zipper does).
    unix_mode: u32,
    is_directory: bool,
}

/// Read and validate every entry of a zip held in memory.
///
/// Only the classic format is accepted, and deliberately: this payload is
/// produced by this repository's own distributer from a few hundred small
/// files, so zip64 cannot occur - and refusing it by name is better than a
/// parser that half-understands it.
fn read_zip(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    let eocd = find_eocd(bytes)
        .ok_or_else(|| "the payload is not a zip (no end-of-central-directory record)".to_string())?;
    if eocd.entries == 0xFFFF || eocd.central_offset == 0xFFFF_FFFF || eocd.central_size == 0xFFFF_FFFF {
        return Err("the payload is a zip64 archive, which this shell does not read".to_string());
    }
    let directory_end = eocd
        .central_offset
        .checked_add(eocd.central_size)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "the payload's central directory runs past the end of the payload".to_string())?;

    let mut entries = Vec::with_capacity(eocd.entries as usize);
    let mut cursor = eocd.central_offset;
    for _ in 0..eocd.entries {
        if cursor + 46 > directory_end {
            return Err("the payload's central directory is truncated".to_string());
        }
        if &bytes[cursor..cursor + 4] != b"PK\x01\x02" {
            return Err("the payload's central directory is malformed".to_string());
        }
        let method = u16_at(bytes, cursor + 10);
        let crc = u32_at(bytes, cursor + 16);
        let compressed = u32_at(bytes, cursor + 20) as usize;
        let uncompressed = u32_at(bytes, cursor + 24) as usize;
        let name_len = u16_at(bytes, cursor + 28) as usize;
        let extra_len = u16_at(bytes, cursor + 30) as usize;
        let comment_len = u16_at(bytes, cursor + 32) as usize;
        let external = u32_at(bytes, cursor + 38);
        let local_header = u32_at(bytes, cursor + 42) as usize;
        let name_start = cursor + 46;
        let name_end = name_start + name_len;
        if name_end > directory_end {
            return Err("the payload's central directory is truncated".to_string());
        }
        let name = String::from_utf8_lossy(&bytes[name_start..name_end]).to_string();
        entries.push(Entry {
            is_directory: name.ends_with('/'),
            name,
            method,
            crc,
            compressed,
            uncompressed,
            local_header,
            unix_mode: external >> 16,
        });
        cursor = name_end + extra_len + comment_len;
    }
    if entries.is_empty() {
        return Err("the payload carries no files".to_string());
    }
    Ok(entries)
}

/// The end-of-central-directory record: its fields are what locate everything
/// else, and its signature is searched for from the END because the record is
/// the last thing in a zip (it may carry a comment, of up to 64 KiB).
fn find_eocd(bytes: &[u8]) -> Option<Eocd> {
    if bytes.len() < 22 {
        return None;
    }
    let earliest = bytes.len().saturating_sub(22 + 0xFFFF);
    for start in (earliest..=bytes.len() - 22).rev() {
        if &bytes[start..start + 4] == b"PK\x05\x06" {
            let comment_len = u16_at(bytes, start + 20) as usize;
            if start + 22 + comment_len == bytes.len() {
                return Some(Eocd {
                    entries: u16_at(bytes, start + 10),
                    central_size: u32_at(bytes, start + 12) as usize,
                    central_offset: u32_at(bytes, start + 16) as usize,
                });
            }
        }
    }
    None
}

struct Eocd {
    entries: u16,
    central_size: usize,
    central_offset: usize,
}

/// Write every entry under `dest`, inflating as it goes.
///
/// The payload zip is the DISTRIBUTION zip, whose entries all sit under one
/// top-level folder (`vncode-<version>-<rid>/`). That component is dropped,
/// which is what makes the unpack directory - not a folder inside it - the thing
/// `START-HERE` is run from.
fn write_entries(bytes: &[u8], entries: &[Entry], dest: &Path) -> Result<(), String> {
    let strip = common_root(entries);
    for entry in entries {
        let relative = safe_relative(&entry.name)
            .ok_or_else(|| format!("the payload carries an entry this shell refuses to unpack: {}", entry.name))?;
        let relative = if strip { drop_first(&relative) } else { Some(relative) };
        let Some(relative) = relative else { continue };
        let target = dest.join(&relative);

        if entry.is_directory {
            fs::create_dir_all(&target).map_err(|error| format!("could not create {}: {error}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }

        let data = entry_data(bytes, entry)?;
        let mut file =
            File::create(&target).map_err(|error| format!("could not write {}: {error}", target.display()))?;
        file.write_all(&data).map_err(|error| format!("could not write {}: {error}", target.display()))?;
        set_mode(&target, mode_for(&relative, entry.unix_mode));
    }
    Ok(())
}

/// An entry's file bytes, inflated and verified.
fn entry_data(bytes: &[u8], entry: &Entry) -> Result<Vec<u8>, String> {
    let header = entry.local_header;
    if header + 30 > bytes.len() || &bytes[header..header + 4] != b"PK\x03\x04" {
        return Err(format!("the payload's entry {} has no local header", entry.name));
    }
    // The LOCAL header's own name/extra lengths are what position the data:
    // the central directory's lengths may differ (a zip may carry a different
    // extra field in each), which is the classic way to read a zip wrongly.
    let name_len = u16_at(bytes, header + 26) as usize;
    let extra_len = u16_at(bytes, header + 28) as usize;
    let start = header + 30 + name_len + extra_len;
    let end = start
        .checked_add(entry.compressed)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| format!("the payload's entry {} is truncated", entry.name))?;
    let raw = &bytes[start..end];

    let data = match entry.method {
        0 => raw.to_vec(),
        8 => {
            let mut out = Vec::with_capacity(entry.uncompressed);
            DeflateDecoder::new(raw)
                .read_to_end(&mut out)
                .map_err(|error| format!("the payload's entry {} could not be inflated: {error}", entry.name))?;
            out
        }
        other => return Err(format!("the payload's entry {} uses compression method {other}", entry.name)),
    };

    if data.len() != entry.uncompressed {
        return Err(format!(
            "the payload's entry {} unpacked to {} bytes, not the {} the zip records",
            entry.name,
            data.len(),
            entry.uncompressed
        ));
    }
    if crc32(&data) != entry.crc {
        return Err(format!("the payload's entry {} failed its CRC-32 check", entry.name));
    }
    Ok(data)
}

/// The single top-level component every entry shares, when there is one.
fn common_root(entries: &[Entry]) -> bool {
    let mut root: Option<&str> = None;
    let mut nested = false;
    for entry in entries {
        let name = entry.name.trim_end_matches('/');
        let (first, rest) = match name.split_once('/') {
            Some((first, rest)) => (first, Some(rest)),
            None => (name, None),
        };
        if first.is_empty() {
            return false;
        }
        match root {
            None => root = Some(first),
            Some(existing) if existing == first => {}
            _ => return false,
        }
        if rest.is_some_and(|rest| !rest.is_empty()) {
            nested = true;
        }
    }
    nested
}

/// Drop the first component of an already-safe relative path.
fn drop_first(relative: &Path) -> Option<PathBuf> {
    let mut parts = relative.components();
    parts.next()?;
    let rest: PathBuf = parts.map(|part| part.as_os_str()).collect();
    if rest.as_os_str().is_empty() {
        None
    } else {
        Some(rest)
    }
}

/// A zip entry name as a relative path, or `None` when it is not one.
///
/// A zip may name `../../etc/something`, `/absolute`, `C:\windows\x` or
/// `foo\bar`; none of those is a file in the distribution, and all of them are
/// refused rather than cleaned up into something that IS a file.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let name = name.trim_end_matches('/');
    if name.is_empty() || name.contains('\\') || name.contains(':') {
        return None;
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// The permission bits a file gets on unix.
///
/// The zip's own record wins when it has one, because that is what the
/// distribution's own `START-HERE.sh` and `vncode` were chmodded to on the
/// machine that built it. A zip built by Windows' zipper records nothing, and
/// then the rule is the distribution's: every `*.sh` and the `vncode`
/// binary itself are meant to be executable, and everything else is not.
fn mode_for(relative: &Path, recorded: u32) -> u32 {
    if recorded & 0o777 != 0 {
        return recorded & 0o7777;
    }
    let name = relative.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if name.ends_with(".sh") || relative == Path::new("vncode") {
        return 0o755;
    }
    0o644
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

// ---------------------------------------------------------------------------
// Little-endian readers and CRC-32
// ---------------------------------------------------------------------------

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Zip's CRC-32: the reflected polynomial, the same one zlib uses.
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 != 0 { 0xEDB8_8320 ^ (value >> 1) } else { value >> 1 };
        }
        *slot = value;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc = table[((crc ^ *byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal, classic zip built by hand - stored entries only, which is
    /// what makes a test of the PARSER possible without a zip crate.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let size = data.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);

            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = out.len() as u32;
        let central_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn trailer() -> Trailer {
        Trailer {
            version: "0.1.1".to_string(),
            rid: "win-x64".to_string(),
            zip_start: 0,
            zip_len: 0,
        }
    }

    #[test]
    fn a_zip_is_read_and_its_entries_located() {
        let zip = build_zip(&[("root/a.txt", b"hello"), ("root/b.txt", b"world!")]);
        let entries = read_zip(&zip).expect("the hand-built zip parses");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "root/a.txt");
        assert_eq!(entry_data(&zip, &entries[0]).unwrap(), b"hello");
        assert_eq!(entry_data(&zip, &entries[1]).unwrap(), b"world!");
    }

    #[test]
    fn a_single_top_level_component_is_detected_and_only_then() {
        let one = read_zip(&build_zip(&[("root/a.txt", b"a"), ("root/deep/b.txt", b"b")])).unwrap();
        assert!(common_root(&one));

        let two = read_zip(&build_zip(&[("one/a.txt", b"a"), ("two/b.txt", b"b")])).unwrap();
        assert!(!common_root(&two), "two different roots must not both be stripped");

        // Loose files at the top level are not a root either.
        let loose = read_zip(&build_zip(&[("a.txt", b"a"), ("b.txt", b"b")])).unwrap();
        assert!(!common_root(&loose));
    }

    #[test]
    fn the_shared_root_component_is_dropped_from_every_target() {
        assert_eq!(drop_first(Path::new("root/a.txt")), Some(PathBuf::from("a.txt")));
        assert_eq!(drop_first(Path::new("root/deep/a.txt")), Some(PathBuf::from("deep/a.txt")));
        assert_eq!(drop_first(Path::new("root")), None, "the root itself unpacks to nothing");
    }

    #[test]
    fn an_entry_that_would_escape_the_unpack_directory_is_refused() {
        for name in [
            "../escape.txt",
            "root/../../escape.txt",
            "/absolute.txt",
            "C:\\windows\\system32\\evil.dll",
            "root\\windows.txt",
            "root/./here.txt",
        ] {
            assert!(safe_relative(name).is_none(), "{name} must be refused");
        }
        assert_eq!(safe_relative("root/a.txt"), Some(PathBuf::from("root/a.txt")));
        assert_eq!(safe_relative("root/sub/"), Some(PathBuf::from("root/sub")));
    }

    #[test]
    fn a_mangled_entry_fails_its_crc_instead_of_unpacking() {
        let mut zip = build_zip(&[("root/a.txt", b"hello")]);
        let entries = read_zip(&zip).unwrap();
        // Flip a byte of the file's DATA, leaving the central directory - and
        // so the recorded CRC - untouched.
        let header = entries[0].local_header;
        let name_len = u16_at(&zip, header + 26) as usize;
        let data_at = header + 30 + name_len;
        zip[data_at] ^= 0xFF;
        let message = entry_data(&zip, &entries[0]).expect_err("a corrupted entry must be reported");
        assert!(message.contains("CRC-32"), "unexpected message: {message}");
    }

    #[test]
    fn the_trailer_round_trips_and_is_validated() {
        let good = r#"{"version":"0.1.1","rid":"win-x64","zipStart":8,"zipLen":99}"#;
        let parsed = parse_trailer(good).expect("a well-formed trailer parses");
        assert_eq!(parsed.version, "0.1.1");
        assert_eq!(parsed.rid, "win-x64");
        assert_eq!(parsed.zip_start, 8);
        assert_eq!(parsed.zip_len, 99);

        for bad in [
            r#"{"rid":"win-x64","zipStart":8,"zipLen":99}"#,
            r#"{"version":"0.1.1","zipStart":8,"zipLen":99}"#,
            r#"{"version":"0.1.1","rid":"win-x64","zipLen":99}"#,
            r#"{"version":"0.1.1","rid":"win-x64","zipStart":8}"#,
            r#"{"version":"0.1.1","rid":"win-x64","zipStart":8,"zipLen":0}"#,
            r#"{"version":"0.1.1","rid":"win-x64","zipStart":-1,"zipLen":99}"#,
            "not json at all",
        ] {
            assert!(parse_trailer(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_trailer_cannot_name_a_directory_it_would_walk_out_of() {
        let escaping = r#"{"version":"../..","rid":"win-x64","zipStart":0,"zipLen":1}"#;
        assert!(parse_trailer(escaping).is_err());
        let absolute = r#"{"version":"0.1.1","rid":"C:/windows","zipStart":0,"zipLen":1}"#;
        assert!(parse_trailer(absolute).is_err());
    }

    #[test]
    fn the_unpack_directory_is_keyed_on_the_payloads_identity() {
        let dir = payload_dir(Path::new("/data"), &trailer());
        assert_eq!(dir, PathBuf::from("/data").join("vncode").join("0.1.1-win-x64"));

        let other = Trailer {
            version: "0.1.2".to_string(),
            ..trailer()
        };
        assert_ne!(
            payload_dir(Path::new("/data"), &trailer()),
            payload_dir(Path::new("/data"), &other),
            "a new version must unpack beside the old one, never over it"
        );
    }

    #[test]
    fn every_sh_and_the_shell_binary_are_executable_without_a_recorded_mode() {
        assert_eq!(mode_for(Path::new("START-HERE.sh"), 0), 0o755);
        assert_eq!(mode_for(Path::new("scripts/install-all.sh"), 0), 0o755);
        assert_eq!(mode_for(Path::new("vncode"), 0), 0o755);
        assert_eq!(mode_for(Path::new("packages/dsh-pdf/lib/index.js"), 0), 0o644);
        // ...and a zip that DID record modes wins over that rule.
        assert_eq!(mode_for(Path::new("vncode"), 0o755), 0o755);
        assert_eq!(mode_for(Path::new("START-HERE.sh"), 0o700), 0o700);
    }

    #[test]
    fn the_crc_matches_a_known_vector() {
        // The canonical check value for "123456789".
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn a_file_that_does_not_end_with_the_magic_is_not_a_payload() {
        let dir = std::env::temp_dir().join(format!("vncode-payload-test-{}", process::id()));
        let _ = fs::create_dir_all(&dir);
        let plain = dir.join("plain.bin");
        fs::write(&plain, b"just an ordinary executable, with no payload at all").unwrap();
        assert_eq!(read_trailer(&plain).unwrap(), None);

        // ...and neither is a file too short to hold a trailer.
        let tiny = dir.join("tiny.bin");
        fs::write(&tiny, b"tiny").unwrap();
        assert_eq!(read_trailer(&tiny).unwrap(), None);

        // The magic followed by an impossible length is an ERROR, not a shrug.
        let lying = dir.join("lying.bin");
        let mut bytes = b"body".to_vec();
        bytes.extend_from_slice(&u64::MAX.to_le_bytes());
        bytes.extend_from_slice(MAGIC);
        fs::write(&lying, &bytes).unwrap();
        assert!(read_trailer(&lying).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_payload_appended_to_a_file_is_found_and_unpacked() {
        let dir = std::env::temp_dir().join(format!("vncode-unpack-test-{}", process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // An executable whose bytes deliberately CONTAIN a zip of their own -
        // the reason the trailer exists and the reason there is no scan for a
        // signature from either end.
        let decoy = build_zip(&[("decoy/file.txt", b"not the payload")]);
        let payload = build_zip(&[("vncode-0.1.1-win-x64/a.txt", b"hello"), ("vncode-0.1.1-win-x64/sub/b.txt", b"world")]);

        let mut exe = b"MZ this is the shell, allegedly".to_vec();
        exe.extend_from_slice(&decoy);
        let zip_start = exe.len() as u64;
        exe.extend_from_slice(&payload);
        let json = format!(
            r#"{{"version":"0.1.1","rid":"win-x64","zipStart":{zip_start},"zipLen":{}}}"#,
            payload.len()
        );
        exe.extend_from_slice(json.as_bytes());
        exe.extend_from_slice(&(json.len() as u64).to_le_bytes());
        exe.extend_from_slice(MAGIC);

        let exe_path = dir.join("vncode-0.1.1-win-x64.exe");
        fs::write(&exe_path, &exe).unwrap();

        let trailer = read_trailer(&exe_path).unwrap().expect("the trailer is found");
        assert_eq!(trailer.zip_start, zip_start);
        assert_eq!(trailer.zip_len, payload.len() as u64);

        let target = dir.join("unpacked");
        let root = ensure_extracted(&exe_path, &trailer, &target).unwrap();
        assert_eq!(root, target);
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "hello");
        assert_eq!(fs::read_to_string(target.join("sub").join("b.txt")).unwrap(), "world");
        assert!(!target.join("decoy").exists(), "the decoy zip must not be unpacked");

        // A second run is a reuse, not a re-unpack: the marker answers first.
        let marker = fs::read_to_string(target.join(MARKER)).unwrap();
        assert_eq!(marker.trim(), "0.1.1-win-x64");
        assert!(is_extracted(&target, &trailer));
        // ...and a DIFFERENT payload is not answered by this directory's marker.
        let other = Trailer {
            version: "0.1.2".to_string(),
            ..trailer.clone()
        };
        assert!(!is_extracted(&target, &other));
        let again = ensure_extracted(&exe_path, &trailer, &target).unwrap();
        assert_eq!(again, target);

        let _ = fs::remove_dir_all(&dir);
    }
}
