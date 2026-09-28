//! The project identity a directory is known by in `context.db`.
//!
//! Memories, notes and every other project-scoped row are keyed by an identity, not by a
//! path: `git:<root commit>` for a git checkout with history, `dir:<md5 prefix of the
//! path>` otherwise. The host computes it in TypeScript
//! (`packages/plugin/src/features/magic-context/memory/project-identity.ts`,
//! `resolveProjectIdentityForSession` with `allowHomeProject` off), and the module has to
//! compute exactly the same value for a route whose session the host never recorded, such
//! as a Claude Code session. This is a port of that function; the golden vectors in the
//! tests below were produced by running it.
//!
//! One deliberate difference: where the host would fall back to a `dir:` identity for a
//! directory it cannot read at all (a path that no longer exists), this refuses. A route
//! keyed on an identity nobody else computes would read an empty memory set and say
//! nothing, so the caller gets an error naming the directory instead.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long `git rev-list` may take before the probe counts as a transient failure.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a `dir:` answer is trusted before the directory is probed again, so a repository
/// initialized later is picked up. A `git:` answer never changes and is kept for good.
const DIRECTORY_REVALIDATE_AFTER: Duration = Duration::from_secs(5 * 60);

/// Why no identity could be computed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectIdentityError {
    /// The session runs in the user's home directory, or in a checkout whose repository
    /// root is the home directory. The host does not treat either as a project.
    HomeDirectory { directory: String },
    /// The directory cannot be read as a directory (missing, not a directory, no access).
    Unreadable { directory: String, reason: String },
}

impl ProjectIdentityError {
    /// The stable code a refusal carries.
    pub fn code(&self) -> &'static str {
        match self {
            Self::HomeDirectory { .. } => "project_identity_home_directory",
            Self::Unreadable { .. } => "project_identity_unreadable",
        }
    }
}

impl std::fmt::Display for ProjectIdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HomeDirectory { directory } => write!(
                f,
                "{directory} is the home directory (or a checkout rooted there), which Magic Context does not treat as a project"
            ),
            Self::Unreadable { directory, reason } => {
                write!(f, "cannot read project directory {directory}: {reason}")
            }
        }
    }
}

impl std::error::Error for ProjectIdentityError {}

/// Node's `path.resolve` for one argument: absolute against the current directory, with
/// `.` and `..` folded lexically and no trailing separator. Symlinks are not followed.
fn node_path_resolve(directory: &Path) -> PathBuf {
    let absolute = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(directory)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            Component::RootDir => resolved.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
        }
    }
    if resolved.as_os_str().is_empty() {
        resolved.push("/");
    }
    resolved
}

/// The `dir:` identity: the first 12 hex digits of the MD5 of the resolved path's UTF-8.
pub fn directory_fallback(directory: &Path) -> String {
    let canonical = node_path_resolve(directory);
    let hash = mc_store::md5_hex(&canonical.to_string_lossy());
    format!("dir:{}", &hash[..12])
}

fn realpath(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The nearest ancestor (the directory itself included) holding a `.git` entry, resolved
/// through symlinks. A `.git` file counts, which is how worktrees and submodules look.
fn git_root_in_ancestor_chain(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(realpath(&current).unwrap_or_else(|| node_path_resolve(&current)));
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

fn git_root_directory(canonical: &Path) -> Option<PathBuf> {
    if let Some(root) = git_root_in_ancestor_chain(canonical) {
        return Some(root);
    }
    let real = realpath(canonical)?;
    if real == canonical {
        None
    } else {
        git_root_in_ancestor_chain(&real)
    }
}

/// The root-commit hash of the checkout at `canonical`, or `None` when git cannot give one
/// (no commits, no git binary, a timeout, ownership refusal). With several roots (merged
/// unrelated histories) the lexicographically smallest is taken, as the host does, so the
/// answer does not depend on git's traversal order.
fn git_root_commit(canonical: &Path) -> Option<String> {
    let mut child = Command::new("git")
        .args(["rev-list", "--max-parents=0", "HEAD"])
        .current_dir(canonical)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(|line| line.trim().chars().take(64).collect::<String>())
        .filter(|line| {
            (7..=64).contains(&line.len())
                && line.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .min()
}

#[derive(Clone)]
struct Cached {
    identity: String,
    /// `None` for a `git:` identity, which never changes.
    revalidate_at: Option<Instant>,
}

/// Resolves and remembers identities for the life of the process.
#[derive(Default)]
pub struct ProjectIdentityResolver {
    cache: Mutex<HashMap<PathBuf, Cached>>,
    /// The last `git:` identity seen per resolved path, reused when a later git probe
    /// fails transiently so one checkout does not flap between two identities.
    last_git: Mutex<HashMap<PathBuf, String>>,
}

impl ProjectIdentityResolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// The identity of `directory`, as the host's `resolveProjectIdentityForSession`
    /// computes it.
    pub fn resolve(&self, directory: &Path) -> Result<String, ProjectIdentityError> {
        let resolved = node_path_resolve(directory);
        if let Some(cached) = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&resolved)
            .cloned()
        {
            if cached
                .revalidate_at
                .is_none_or(|revalidate_at| Instant::now() < revalidate_at)
            {
                return Ok(cached.identity);
            }
        }
        let identity = self.resolve_uncached(&resolved)?;
        let revalidate_at = (!identity.starts_with("git:"))
            .then(|| Instant::now() + DIRECTORY_REVALIDATE_AFTER);
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                resolved,
                Cached {
                    identity: identity.clone(),
                    revalidate_at,
                },
            );
        Ok(identity)
    }

    fn resolve_uncached(&self, resolved: &Path) -> Result<String, ProjectIdentityError> {
        let display = resolved.display().to_string();
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let canonical_home = realpath(&home).unwrap_or(home);
        let canonical_directory = realpath(resolved).unwrap_or_else(|| resolved.to_path_buf());
        let inherits_home =
            git_root_directory(&canonical_directory).is_some_and(|root| root == canonical_home);
        if canonical_directory == canonical_home || inherits_home {
            return Err(ProjectIdentityError::HomeDirectory { directory: display });
        }
        match std::fs::metadata(resolved) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(ProjectIdentityError::Unreadable {
                    directory: display,
                    reason: "not a directory".to_string(),
                })
            }
            Err(error) => {
                return Err(ProjectIdentityError::Unreadable {
                    directory: display,
                    reason: error.to_string(),
                })
            }
        }
        if git_root_directory(resolved).is_none() {
            return Ok(directory_fallback(resolved));
        }
        match git_root_commit(resolved) {
            Some(root) => {
                let identity = format!("git:{root}");
                self.last_git
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(resolved.to_path_buf(), identity.clone());
                Ok(identity)
            }
            None => {
                // No root commit: an empty repository, a missing git binary, a timeout or
                // an ownership refusal. The host reuses the last identity it saw for this
                // path or an ancestor, and otherwise falls back to the directory hash.
                let last = self
                    .last_git
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let mut current = Some(resolved);
                while let Some(path) = current {
                    if let Some(identity) = last.get(path) {
                        return Ok(identity.clone());
                    }
                    current = path.parent();
                }
                Ok(directory_fallback(resolved))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values printed by the host's own function (see the module documentation) for the
    /// same inputs. A change on either side that alters them splits every project's
    /// memories between the host and the module.
    #[test]
    fn directory_identities_match_the_hosts_golden_vectors() {
        for (directory, expected) in DIRECTORY_GOLDEN {
            assert_eq!(
                directory_fallback(Path::new(directory)),
                *expected,
                "dir identity of {directory}"
            );
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "golden")
            .env("GIT_AUTHOR_EMAIL", "golden@example.invalid")
            .env("GIT_COMMITTER_NAME", "golden")
            .env("GIT_COMMITTER_EMAIL", "golden@example.invalid")
            .env("GIT_AUTHOR_DATE", "2001-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2001-01-01T00:00:00Z")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    }

    /// A fixed repository (fixed author, dates and content) has a fixed root commit, so the
    /// host's answer for it is a golden value too. Every spelling of a place inside the
    /// checkout (a worktree, a subdirectory, a trailing slash, a symlink) resolves to it.
    #[test]
    fn a_checkout_resolves_to_the_hosts_root_commit_identity_from_every_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README"), "golden\n").unwrap();
        git(&repo, &["add", "README"]);
        git(&repo, &["commit", "-q", "-m", "golden root"]);
        let worktree = dir.path().join("worktree");
        git(
            &repo,
            &["worktree", "add", "-q", worktree.to_str().unwrap(), "-b", "wt"],
        );
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let resolver = ProjectIdentityResolver::new();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        for place in [
            repo.clone(),
            repo.join("sub"),
            PathBuf::from(format!("{}/", repo.display())),
            worktree,
            link,
        ] {
            assert_eq!(resolver.resolve(&place).unwrap(), expected, "{place:?}");
        }
    }

    #[test]
    fn a_directory_without_git_resolves_to_its_path_hash_and_a_missing_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let resolver = ProjectIdentityResolver::new();
        assert_eq!(resolver.resolve(&plain).unwrap(), directory_fallback(&plain));
        let gone = dir.path().join("gone");
        assert!(matches!(
            resolver.resolve(&gone),
            Err(ProjectIdentityError::Unreadable { .. })
        ));
    }
}

/// `(input, identity)` pairs printed by the host's `resolveProjectIdentity` for paths that
/// do not exist, which is its `dir:` fallback of the resolved path.
#[cfg(test)]
const DIRECTORY_GOLDEN: &[(&str, &str)] = &[
    ("/work/api", "dir:e02ef1f35c06"),
    ("/work/api/", "dir:e02ef1f35c06"),
    ("/work/./x/../api", "dir:e02ef1f35c06"),
    ("/tmp/n\u{e4}me dir", "dir:93e3ea277593"),
    ("/", "dir:6666cd76f969"),
];

/// The root commit the host's `resolveProjectIdentityForSession` resolves for the fixed
/// repository built in the checkout test, from the repository, a subdirectory, a trailing
/// slash, a worktree and a symlink alike.
#[cfg(test)]
const GOLDEN_ROOT_COMMIT: &str = "5dd1e9f0bd6f4800131f7c6887d174ffceac99d6";
