//! The git identity commits are made under, global and per repository (G14).
//!
//! This is deliberately *not* part of `settings.rs`: it is git's state, not the
//! app's, and it has to stay that way. A user who sets their name here and then
//! commits from the terminal panel must get the same author — which means
//! writing `user.name` and `user.email` into git's own config files, at the
//! level git itself would consult, and never keeping a private copy.

use crate::error::{Error, Result};
use git2::{Config, ConfigLevel, Repository};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdentityScope {
    Global,
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    pub global_name: Option<String>,
    pub global_email: Option<String>,
    /// The repository's own override, when one is set. `None` here with a
    /// value in `effective_name` is how "inherited from global" is shown.
    pub repo_name: Option<String>,
    pub repo_email: Option<String>,
    /// What git would actually stamp on a commit made right now.
    pub effective_name: Option<String>,
    pub effective_email: Option<String>,
}

fn get(config: &Config, key: &str) -> Option<String> {
    config.get_string(key).ok().filter(|v| !v.trim().is_empty())
}

/// Open the global config for writing, creating `~/.gitconfig` if git has
/// never written one on this machine.
fn global_config() -> Result<Config> {
    if let Ok(path) = Config::find_global() {
        return Ok(Config::open(&path)?);
    }
    let home = dirs_home().ok_or_else(|| Error::Msg("No home directory to write ~/.gitconfig".into()))?;
    let path = home.join(".gitconfig");
    if !path.exists() {
        std::fs::write(&path, "")?;
    }
    Ok(Config::open(&path)?)
}

fn dirs_home() -> Option<std::path::PathBuf> {
    // Deliberately not a dependency: one variable on each platform, and the
    // only caller is the "git has never run here" path.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// Read the identity at both levels. `repo` is optional: the settings screen
/// shows the global identity with no repository open.
pub fn read(repo: Option<&Repository>) -> Result<IdentityInfo> {
    let mut info = IdentityInfo::default();

    // `open_default` is system + global + XDG, with no repository in it, which
    // is exactly the "global" column.
    if let Ok(config) = Config::open_default().and_then(|mut c| c.snapshot()) {
        info.global_name = get(&config, "user.name");
        info.global_email = get(&config, "user.email");
    }

    if let Some(repo) = repo {
        let mut config = repo.config()?;
        if let Ok(local) = config.open_level(ConfigLevel::Local).and_then(|mut c| c.snapshot()) {
            info.repo_name = get(&local, "user.name");
            info.repo_email = get(&local, "user.email");
        }
        let merged = config.snapshot()?;
        info.effective_name = get(&merged, "user.name");
        info.effective_email = get(&merged, "user.email");
    } else {
        info.effective_name = info.global_name.clone();
        info.effective_email = info.global_email.clone();
    }

    Ok(info)
}

/// Set or clear `user.name` / `user.email` in one config file.
///
/// An empty value *removes* the entry rather than writing an empty string:
/// `user.email = ""` is not "inherit", it is an identity git will happily
/// commit under, and the difference is invisible in the UI.
pub fn write_into(config: &mut Config, name: &str, email: &str) -> Result<()> {
    for (key, value) in [("user.name", name), ("user.email", email)] {
        let value = value.trim();
        if value.is_empty() {
            match config.remove(key) {
                Ok(()) => {}
                // Removing something that was never set is the intent, not an
                // error; git2 reports it as NotFound.
                Err(e) if e.code() == git2::ErrorCode::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        } else {
            config.set_str(key, value)?;
        }
    }
    Ok(())
}

/// Write the identity at `scope`. `repo` is required for `Repo`.
pub fn write(scope: IdentityScope, repo: Option<&Repository>, name: &str, email: &str) -> Result<()> {
    match scope {
        IdentityScope::Global => write_into(&mut global_config()?, name, email),
        IdentityScope::Repo => {
            let repo = repo.ok_or_else(|| Error::Msg("No repository open".into()))?;
            let mut local = repo.config()?.open_level(ConfigLevel::Local)?;
            write_into(&mut local, name, email)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn a_repo_override_shadows_the_global_identity() {
        let t = TestRepo::new();
        write(IdentityScope::Repo, Some(&t.repo), "Ada Lovelace", "ada@example.com").unwrap();

        let info = read(Some(&t.repo)).unwrap();
        assert_eq!(info.repo_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(info.repo_email.as_deref(), Some("ada@example.com"));
        assert_eq!(info.effective_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(info.effective_email.as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn clearing_an_override_removes_it_rather_than_writing_an_empty_identity() {
        // The bug this guards: `user.email = ""` is not "inherit from global",
        // it is an identity git will commit under, and the UI cannot show the
        // difference between an empty override and no override at all.
        let t = TestRepo::new();
        write(IdentityScope::Repo, Some(&t.repo), "Ada", "ada@example.com").unwrap();
        write(IdentityScope::Repo, Some(&t.repo), "", "").unwrap();

        let info = read(Some(&t.repo)).unwrap();
        assert_eq!(info.repo_name, None);
        assert_eq!(info.repo_email, None);

        let local = t.repo.config().unwrap().open_level(ConfigLevel::Local).unwrap();
        assert!(local.get_string("user.email").is_err(), "entry is gone, not empty");
    }

    #[test]
    fn clearing_an_identity_that_was_never_set_is_not_an_error() {
        let t = TestRepo::new();
        assert!(write(IdentityScope::Repo, Some(&t.repo), "", "").is_ok());
    }

    #[test]
    fn whitespace_is_trimmed_and_a_blank_value_reads_as_unset() {
        let t = TestRepo::new();
        write(IdentityScope::Repo, Some(&t.repo), "  Ada  ", "   ").unwrap();

        let info = read(Some(&t.repo)).unwrap();
        assert_eq!(info.repo_name.as_deref(), Some("Ada"));
        assert_eq!(info.repo_email, None);
    }

    #[test]
    fn writing_the_repo_scope_without_a_repository_is_refused() {
        assert!(write(IdentityScope::Repo, None, "Ada", "ada@example.com").is_err());
    }

    #[test]
    fn write_into_targets_exactly_the_file_it_is_given() {
        // The global path is tested through this rather than through `write`:
        // exercising `IdentityScope::Global` for real would edit the
        // developer's own ~/.gitconfig.
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("gitconfig");
        std::fs::write(&file, "").unwrap();

        let mut config = Config::open(&file).unwrap();
        write_into(&mut config, "Ada", "ada@example.com").unwrap();

        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("name = Ada"), "{text}");
        assert!(text.contains("email = ada@example.com"), "{text}");
    }
}
