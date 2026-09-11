//! Autolinks (G20): turning `#123` or `PROJ-4` in a commit message into a
//! link out to the issue tracker.
//!
//! **Link out only — no network calls, ever.** GitLens's enriched autolinks
//! (fetching the issue title and state) live behind an account in its `plus/`
//! tree, and `00-overview.md` §8.2 keeps that whole tier out of scope. What is
//! left is pure string work, which also means an autolink can never make the
//! commit panel slow or leak a repository name to a third party.

use crate::error::Result;
use git2::Repository;
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutolinkPattern {
    /// Literal text that starts a reference, e.g. `#` or `PROJ-`.
    pub prefix: String,
    /// Target URL with `<num>` standing in for the matched reference.
    pub url: String,
    /// Whether the reference body may contain letters as well as digits.
    pub alphanumeric: bool,
    /// `"config"` for a user pattern, `"builtin"` for one derived from the
    /// origin remote's host. The UI labels them so a surprising link can be
    /// traced to where it came from.
    pub source: String,
}

/// A remote URL reduced to the three parts an autolink needs.
#[derive(Debug, PartialEq)]
pub struct RemoteParts {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// Parse the two shapes git remotes actually come in: a URL with a scheme, and
/// scp-like `git@host:owner/repo.git`.
///
/// Hand-rolled rather than pulled from a crate because the scp form is not a
/// URL — `git@github.com:o/r.git` parses as a URL with scheme `git` and an
/// empty host, which is how this goes quietly wrong.
pub fn parse_remote(url: &str) -> Option<RemoteParts> {
    let url = url.trim();
    let rest = if let Some((_scheme, after)) = url.split_once("://") {
        after
    } else if let Some((before, after)) = url.split_once(':') {
        // scp-like. Three shapes have to be turned away here: a path with a
        // directory before the colon, a `host:2222/...` port (that was a URL
        // after all), and `C:/repos/bare` — a Windows path whose "host" is a
        // drive letter. The dot test covers the last one, and costs us only
        // ssh-config aliases, which carry no host we could map a tracker to.
        let host = before.rsplit('@').next()?;
        if before.contains('/')
            || after.starts_with(|c: char| c.is_ascii_digit())
            || !host.contains('.')
        {
            return None;
        }
        return split_path(host, after);
    } else {
        return None;
    };

    let (authority, path) = rest.split_once('/')?;
    let host = authority.rsplit('@').next()?;
    let host = host.split_once(':').map_or(host, |(h, _port)| h);
    split_path(host, path)
}

fn split_path(host: &str, path: &str) -> Option<RemoteParts> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.rsplit_once('/')?;
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(RemoteParts {
        host: host.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// The `#123` pattern for the hosts whose issue URL shape we know.
///
/// Only these three: a guess at an unknown host produces a link that 404s,
/// and a broken link is worse than plain text because the user follows it.
fn builtin_for(parts: &RemoteParts) -> Option<AutolinkPattern> {
    let base = format!("https://{}/{}/{}", parts.host, parts.owner, parts.repo);
    let host = parts.host.to_lowercase();
    let path = if host == "github.com" || host.ends_with(".github.com") {
        "issues"
    } else if host == "gitlab.com" || host.ends_with(".gitlab.com") {
        "-/issues"
    } else if host == "bitbucket.org" {
        "issues"
    } else {
        return None;
    };
    Some(AutolinkPattern {
        prefix: "#".into(),
        url: format!("{base}/{path}/<num>"),
        alphanumeric: false,
        source: "builtin".into(),
    })
}

/// User patterns from repo config plus the built-in for origin's host.
///
/// Config shape mirrors GitLens's, one section per pattern:
///
/// ```text
/// [mtgit "autolink.jira"]
///     prefix = PROJ-
///     url = https://example.atlassian.net/browse/<num>
///     alphanumeric = true
/// ```
pub fn patterns(repo: &Repository) -> Result<Vec<AutolinkPattern>> {
    let mut out = Vec::new();
    let cfg = repo.config()?;

    if let Ok(entries) = cfg.entries(Some("mtgit.autolink.*.prefix")) {
        entries.for_each(|entry| {
            let (Some(name), Some(prefix)) = (entry.name(), entry.value()) else { return };
            let stem = name.trim_end_matches(".prefix");
            let Ok(url) = cfg.get_string(&format!("{stem}.url")) else { return };
            if prefix.is_empty() || !url.contains("<num>") {
                // A pattern with no placeholder would link every reference to
                // the same page — almost certainly a typo, and silently wrong.
                return;
            }
            out.push(AutolinkPattern {
                prefix: prefix.to_string(),
                url,
                alphanumeric: cfg.get_bool(&format!("{stem}.alphanumeric")).unwrap_or(false),
                source: "config".into(),
            });
        })?;
    }

    if let Some(builtin) = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(str::to_string))
        .as_deref()
        .and_then(parse_remote)
        .as_ref()
        .and_then(builtin_for)
    {
        // A configured `#` pattern wins: the user pointed it somewhere on
        // purpose, and the built-in is only a guess from the remote host.
        if !out.iter().any(|p| p.prefix == builtin.prefix) {
            out.push(builtin);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn scp_style_remotes_parse_as_urls_do() {
        let https = parse_remote("https://github.com/acme/widget.git").unwrap();
        let scp = parse_remote("git@github.com:acme/widget.git").unwrap();
        assert_eq!(https, scp);
        assert_eq!(https.host, "github.com");
        assert_eq!(https.owner, "acme");
        assert_eq!(https.repo, "widget");
    }

    #[test]
    fn a_remote_with_a_port_or_a_nested_group_still_resolves() {
        let ssh = parse_remote("ssh://git@gitlab.example.com:2222/group/sub/proj.git").unwrap();
        assert_eq!(ssh.host, "gitlab.example.com");
        assert_eq!(ssh.owner, "group/sub");
        assert_eq!(ssh.repo, "proj");
    }

    #[test]
    fn a_path_that_is_not_a_remote_yields_nothing() {
        assert!(parse_remote("/srv/repos/bare.git").is_none());
        assert!(parse_remote("C:/repos/bare").is_none());
        assert!(parse_remote("https://github.com/onlyowner").is_none());
    }

    /// The rule that keeps autolinks trustworthy: we only guess an issue URL
    /// for hosts whose shape we actually know.
    #[test]
    fn no_builtin_pattern_for_an_unknown_host() {
        let t = TestRepo::new();
        t.repo.remote("origin", "https://git.internal.example/acme/widget.git").unwrap();
        assert!(patterns(&t.repo).unwrap().is_empty());
    }

    #[test]
    fn github_origin_gets_a_hash_pattern() {
        let t = TestRepo::new();
        t.repo.remote("origin", "git@github.com:acme/widget.git").unwrap();
        let p = patterns(&t.repo).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].prefix, "#");
        assert_eq!(p[0].url, "https://github.com/acme/widget/issues/<num>");
        assert_eq!(p[0].source, "builtin");
    }

    #[test]
    fn a_configured_pattern_overrides_the_builtin_for_the_same_prefix() {
        let t = TestRepo::new();
        t.repo.remote("origin", "git@github.com:acme/widget.git").unwrap();
        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("mtgit.autolink.hash.prefix", "#").unwrap();
        cfg.set_str("mtgit.autolink.hash.url", "https://tracker.example/t/<num>").unwrap();

        let p = patterns(&t.repo).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].source, "config");
        assert_eq!(p[0].url, "https://tracker.example/t/<num>");
    }

    #[test]
    fn a_pattern_without_the_placeholder_is_dropped() {
        let t = TestRepo::new();
        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("mtgit.autolink.bad.prefix", "PROJ-").unwrap();
        cfg.set_str("mtgit.autolink.bad.url", "https://example.com/browse").unwrap();
        assert!(patterns(&t.repo).unwrap().is_empty());
    }

    #[test]
    fn an_alphanumeric_pattern_round_trips() {
        let t = TestRepo::new();
        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("mtgit.autolink.jira.prefix", "PROJ-").unwrap();
        cfg.set_str("mtgit.autolink.jira.url", "https://example.com/browse/PROJ-<num>").unwrap();
        cfg.set_bool("mtgit.autolink.jira.alphanumeric", true).unwrap();

        let p = patterns(&t.repo).unwrap();
        assert_eq!(p.len(), 1);
        assert!(p[0].alphanumeric);
        assert_eq!(p[0].prefix, "PROJ-");
    }
}
