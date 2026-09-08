//! Commit search — the GitLens query grammar, parsed and executed in Rust.
//!
//! The grammar (`docs/feature-requirements/08-search-and-filter.md` §3) was
//! read out of `packages/git/src/models/search.ts` and
//! `packages/git/src/utils/search.utils.ts` in `gitkraken/vscode-gitlens`
//! (the MIT half of that repo). Behaviour is matched, not code: nothing here
//! is a translation of theirs.
//!
//! ## Why parsing lives on this side
//!
//! Every operator here is a `git log` flag in disguise, and choosing which
//! flag a term becomes *is* git logic — the same reason the frontend never
//! computes graph layout (`CLAUDE.md` invariant 5). A parser in `src/` would
//! also have to know the two traps below, and it would learn them by shipping
//! them.
//!
//! ## Two traps
//!
//! 1. **`--invert-grep` inverts every `--grep` in the command.** A query
//!    mixing `message:` and `-message:` therefore cannot be one `git log`
//!    invocation. [`build`] emits a second, *negative* invocation whose result
//!    set is subtracted, so neither term is silently dropped.
//! 2. **Values are data, never options.** We run the real `git` binary
//!    (invariant 6), so a `ref:--upload-pack=…` reaching argv as its own word
//!    is command injection. Every value is either attached to its flag
//!    (`--grep=-x` is one word and cannot be read as an option), pushed after
//!    `--`, or — for the two operators that must be standalone argv words,
//!    `ref:` and `commit:` — rejected outright when it starts with `-`.

use crate::error::{Error, Result};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

/// Emit a progress tick every this many oids read from `git log`.
const PROGRESS_EVERY: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Message,
    NotMessage,
    Author,
    Committer,
    Commit,
    File,
    Change,
    Type,
    After,
    Before,
    Ref,
}

/// Long form first; the long form is what the field normalises to.
const OPERATORS: &[(&str, Operator)] = &[
    ("-message:", Operator::NotMessage),
    ("message:", Operator::Message),
    ("=:", Operator::Message),
    ("author:", Operator::Author),
    ("@:", Operator::Author),
    ("committer:", Operator::Committer),
    ("commit:", Operator::Commit),
    ("#:", Operator::Commit),
    ("file:", Operator::File),
    ("?:", Operator::File),
    ("change:", Operator::Change),
    ("~:", Operator::Change),
    ("type:", Operator::Type),
    ("is:", Operator::Type),
    ("after:", Operator::After),
    ("since:", Operator::After),
    (">:", Operator::After),
    ("before:", Operator::Before),
    ("until:", Operator::Before),
    ("<:", Operator::Before),
    ("ref:", Operator::Ref),
    ("^:", Operator::Ref),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    pub op: Operator,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    pub terms: Vec<Term>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub match_case: bool,
    /// AND the message terms together (`--all-match`) instead of OR-ing them.
    pub match_all: bool,
    pub match_regex: bool,
    pub match_whole_word: bool,
    /// Rows per graph page — mirrors `PAGE_SIZE` in `GraphView`, and turns a
    /// row index into the page the frontend has to load to reveal a hit.
    pub page_size: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        // GitLens's own defaults: OR across message terms, case-insensitive,
        // fixed strings rather than regex.
        SearchOptions {
            match_case: false,
            match_all: false,
            match_regex: false,
            match_whole_word: false,
            page_size: 2000,
        }
    }
}

/// A filter that cannot be expressed as a `git log` flag and is therefore
/// applied to the walk's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Post {
    /// `type:tip` — keep only commits a branch or tag points *directly* at.
    Tip,
    /// `commit:` — keep only commits whose oid starts with this prefix.
    CommitPrefix(String),
}

/// Everything needed to run one query: the walk, an optional walk whose
/// results are subtracted, filters applied afterwards, and (for a query made
/// only of `commit:` terms) a direct rev lookup that needs no walk at all.
#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub args: Vec<String>,
    pub negative: Option<Vec<String>>,
    pub post: Vec<Post>,
    pub direct: Option<Vec<String>>,
    /// Things the user should be told about how their query was executed.
    pub notes: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Outcome {
    /// Matching oids, in `git log` order (the caller re-orders to graph order).
    pub oids: Vec<String>,
    pub truncated: bool,
    pub cancelled: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub oid: String,
    /// Row index in the graph's own order, or `None` for a commit the graph
    /// does not contain (a stash commit, or one no ref reaches).
    pub index: Option<usize>,
    /// Which `get_graph` page `index` falls on.
    pub page_hint: Option<usize>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    /// The result cap cut the list short. Never truncate silently (B4).
    pub truncated: bool,
    pub cancelled: bool,
    /// How the query reads back in prose, for the empty state.
    pub summary: String,
    pub notes: Vec<String>,
}

// ---- parsing -----------------------------------------------------------------

struct Token {
    text: String,
    /// The token opened with a `"`, so it is a literal message term whatever
    /// it looks like — this is how `"fix: thing"` is searched for verbatim.
    quoted: bool,
}

fn tokenize(input: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = input.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let quoted = chars.peek() == Some(&'"');
        let mut text = String::new();
        let mut in_quotes = false;
        while let Some(&c) = chars.peek() {
            if c == '"' {
                chars.next();
                in_quotes = !in_quotes;
                continue;
            }
            if c.is_whitespace() && !in_quotes {
                break;
            }
            text.push(c);
            chars.next();
        }
        out.push(Token { text, quoted });
    }
    out
}

fn split_operator(tok: &str) -> Option<(Operator, &str)> {
    OPERATORS
        .iter()
        .find(|(prefix, _)| tok.starts_with(prefix))
        .map(|(prefix, op)| (*op, &tok[prefix.len()..]))
}

/// Does this token *look* like an operator we do not know?
///
/// An unknown operator must be an error rather than a message term (§4), or a
/// typo'd `athor:` silently searches messages for "athor:". The two exclusions
/// keep that from swallowing ordinary text: a long prefix is prose, and a
/// value continuing with a path separator is a URL or a Windows path
/// (`https://…`, `C:\src`), not an operator.
fn looks_like_operator(tok: &str) -> Option<&str> {
    let (prefix, rest) = tok.split_once(':')?;
    let name = prefix.strip_prefix('-').unwrap_or(prefix);
    if name.is_empty() || name.len() > 12 || !name.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if rest.starts_with('/') || rest.starts_with('\\') {
        return None;
    }
    Some(prefix)
}

/// Parse a query string. A bare term means `message:`.
///
/// An operator with an empty value is *dropped*, not rejected: the field
/// searches as you type, and `author:` is a query halfway through being typed
/// rather than a mistake.
pub fn parse(input: &str) -> Result<Query> {
    let mut terms = Vec::new();
    for tok in tokenize(input) {
        if tok.text.is_empty() {
            continue;
        }
        if tok.quoted {
            terms.push(Term { op: Operator::Message, value: tok.text });
            continue;
        }
        match split_operator(&tok.text) {
            Some((op, value)) => {
                if value.is_empty() {
                    continue;
                }
                if op == Operator::Type && !matches!(value, "stash" | "tip" | "merge") {
                    return Err(Error::Msg(format!(
                        "type: accepts stash, tip or merge — not '{value}'"
                    )));
                }
                terms.push(Term { op, value: value.to_string() });
            }
            None => {
                if let Some(prefix) = looks_like_operator(&tok.text) {
                    return Err(Error::Msg(format!(
                        "unknown operator '{prefix}:' — quote the term to search for it literally"
                    )));
                }
                terms.push(Term { op: Operator::Message, value: tok.text });
            }
        }
    }
    Ok(Query { terms })
}

impl Query {
    fn values(&self, op: Operator) -> Vec<&str> {
        self.terms.iter().filter(|t| t.op == op).map(|t| t.value.as_str()).collect()
    }

    fn has_type(&self, kind: &str) -> bool {
        self.terms.iter().any(|t| t.op == Operator::Type && t.value == kind)
    }

    /// True when the query contains a pickaxe term, which diffs every commit
    /// it walks. The frontend uses this to require Enter rather than searching
    /// as the user types (§6).
    pub fn is_expensive(&self) -> bool {
        self.terms.iter().any(|t| t.op == Operator::Change)
    }

    /// The query read back as prose, so a typo'd operator is visible in the
    /// empty state ("No commits by @me touching src/** after 2026-01-01").
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        let join = |vs: Vec<&str>| vs.join(" or ");
        let mut add = |label: &str, vs: Vec<&str>| {
            if !vs.is_empty() {
                parts.push(format!("{label} {}", join(vs)));
            }
        };
        add("matching", self.values(Operator::Message));
        add("not matching", self.values(Operator::NotMessage));
        add("by", self.values(Operator::Author));
        add("committed by", self.values(Operator::Committer));
        add("with sha", self.values(Operator::Commit));
        add("touching", self.values(Operator::File));
        add("adding or removing", self.values(Operator::Change));
        add("of type", self.values(Operator::Type));
        add("after", self.values(Operator::After));
        add("before", self.values(Operator::Before));
        add("in", self.values(Operator::Ref));
        if parts.is_empty() {
            return "matching an empty query".to_string();
        }
        parts.join(", ")
    }
}

// ---- building the git invocation ---------------------------------------------

/// Reject a value that would reach argv as its own word while looking like an
/// option. Only `ref:` and `commit:` values do; see the module note.
fn guard_standalone(op: &str, value: &str) -> Result<()> {
    if value.starts_with('-') {
        return Err(Error::Msg(format!(
            "{op} value '{value}' starts with '-', which git would read as an option"
        )));
    }
    Ok(())
}

/// Escape a fixed string for POSIX extended regular expressions.
fn escape_ere(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for c in value.chars() {
        if "\\.[]{}()*+?^$|".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Turn one message/author/committer value into the pattern git receives.
fn pattern(value: &str, opts: &SearchOptions) -> String {
    if opts.match_whole_word {
        // git has no `--word-regexp` for `--grep`, so whole-word matching is
        // expressed as explicit boundaries — which forces regex mode, hence
        // the escaping when the user did not ask for regex.
        let body = if opts.match_regex { value.to_string() } else { escape_ere(value) };
        format!("\\b{body}\\b")
    } else {
        value.to_string()
    }
}

/// Build the `git log` invocation(s) for a parsed query.
pub fn build(
    query: &Query,
    opts: &SearchOptions,
    me: Option<&str>,
    head_ok: bool,
) -> Result<Plan> {
    let mut plan = Plan::default();

    let commits = query.values(Operator::Commit);
    let others = query.terms.iter().any(|t| t.op != Operator::Commit);
    if !commits.is_empty() && !others {
        // A query of nothing but `commit:` is a rev lookup, not a walk — so a
        // commit no ref reaches (a dangling one, or one only a reflog holds)
        // is still findable by sha.
        for value in &commits {
            guard_standalone("commit:", value)?;
        }
        plan.direct = Some(commits.iter().map(|s| s.to_string()).collect());
        return Ok(plan);
    }

    let mut args: Vec<String> = vec!["log".into(), "--format=%H".into()];

    let messages = query.values(Operator::Message);
    let authors = query.values(Operator::Author);
    let committers = query.values(Operator::Committer);
    let grep_count = messages.len() + authors.len() + committers.len();

    for value in &messages {
        args.push(format!("--grep={}", pattern(value, opts)));
    }
    for value in &authors {
        args.push(format!("--author={}", pattern(&resolve_me(value, me), opts)));
    }
    for value in &committers {
        args.push(format!("--committer={}", pattern(&resolve_me(value, me), opts)));
    }
    if grep_count > 0 {
        // Without this a message search for `a.b.c` or `(fix)` quietly
        // matches the wrong things: regex-by-default is a footgun for a field
        // that looks like plain text.
        if opts.match_regex || opts.match_whole_word {
            args.push("--extended-regexp".into());
        } else {
            args.push("--fixed-strings".into());
        }
        if !opts.match_case {
            args.push("--regexp-ignore-case".into());
        }
        if opts.match_all && grep_count > 1 {
            args.push("--all-match".into());
        }
        if !opts.match_all && grep_count > 1 && messages.len() != grep_count {
            plan.notes.push(
                "'match any' applies to message terms; git applies author, committer and date terms together."
                    .into(),
            );
        }
    }

    for value in query.values(Operator::After) {
        args.push(format!("--after={value}"));
    }
    for value in query.values(Operator::Before) {
        args.push(format!("--before={value}"));
    }
    for value in query.values(Operator::Change) {
        // `-S` counts occurrences, `-G` matches the diff text; regex mode is
        // the difference between them, as in GitLens.
        args.push(if opts.match_regex { format!("-G{value}") } else { format!("-S{value}") });
    }
    if query.has_type("merge") {
        args.push("--merges".into());
    }

    // Ref scoping. `type:stash` walks the stash reflog instead of the ref set,
    // so the two are mutually exclusive.
    let refs = query.values(Operator::Ref);
    if query.has_type("stash") {
        args.push("--walk-reflogs".into());
        args.push("refs/stash".into());
        if !refs.is_empty() {
            plan.notes.push("type:stash walks the stash reflog; ref: was ignored.".into());
        }
    } else if refs.is_empty() {
        // The same seeds `graph::layout` walks, so a hit always has a row.
        args.push("--branches".into());
        args.push("--tags".into());
        args.push("--remotes".into());
        // A detached HEAD is reachable through no ref, so it has to be named —
        // but naming an unborn one is a fatal error, not an empty result.
        if head_ok {
            args.push("HEAD".into());
        }
    } else {
        for value in &refs {
            guard_standalone("ref:", value)?;
            args.push((*value).to_string());
        }
    }

    let files = query.values(Operator::File);
    if !files.is_empty() {
        // Everything after `--` is a pathspec, so a leading `-` here is inert.
        args.push("--".into());
        for value in &files {
            args.push((*value).to_string());
        }
    }

    // Trap 1: `--invert-grep` would invert the positive `--grep`s too, so the
    // negative half is a separate walk whose results are subtracted.
    let negatives = query.values(Operator::NotMessage);
    if !negatives.is_empty() {
        if messages.is_empty() && authors.is_empty() && committers.is_empty() {
            args.push("--invert-grep".into());
            for value in &negatives {
                args.push(format!("--grep={}", pattern(value, opts)));
            }
            if opts.match_regex || opts.match_whole_word {
                args.push("--extended-regexp".into());
            } else {
                args.push("--fixed-strings".into());
            }
            if !opts.match_case {
                args.push("--regexp-ignore-case".into());
            }
        } else {
            let mut neg: Vec<String> = vec!["log".into(), "--format=%H".into()];
            for value in &negatives {
                neg.push(format!("--grep={}", pattern(value, opts)));
            }
            if opts.match_regex || opts.match_whole_word {
                neg.push("--extended-regexp".into());
            } else {
                neg.push("--fixed-strings".into());
            }
            if !opts.match_case {
                neg.push("--regexp-ignore-case".into());
            }
            // Scope the subtraction the same way, or it subtracts commits the
            // positive walk never considered.
            let scope_start = args.iter().position(|a| a == "--branches" || a == "--walk-reflogs");
            if let Some(start) = scope_start {
                neg.extend(args[start..].iter().cloned());
            } else {
                neg.extend(refs.iter().map(|r| (*r).to_string()));
                if !files.is_empty() {
                    neg.push("--".into());
                    neg.extend(query.values(Operator::File).iter().map(|f| f.to_string()));
                }
            }
            plan.negative = Some(neg);
        }
    }

    if query.has_type("tip") {
        plan.post.push(Post::Tip);
    }
    for value in commits {
        guard_standalone("commit:", value)?;
        plan.post.push(Post::CommitPrefix(value.to_lowercase()));
    }

    plan.args = args;
    Ok(plan)
}

fn resolve_me(value: &str, me: Option<&str>) -> String {
    if value == "@me" {
        me.unwrap_or(value).to_string()
    } else {
        value.to_string()
    }
}

/// The current git identity, preferred as the email (author strings are
/// matched as substrings of `Name <email>`, and an email is unambiguous).
pub fn current_identity(repo: &Repository) -> Option<String> {
    let config = repo.config().ok()?;
    config
        .get_string("user.email")
        .ok()
        .or_else(|| config.get_string("user.name").ok())
        .filter(|s| !s.is_empty())
}

// ---- execution ---------------------------------------------------------------

/// Run `git log` and collect the oids it prints.
///
/// Both pipes are drained concurrently for the reason `shellout::drain`
/// documents: reading stderr to EOF first deadlocks the moment stdout's pipe
/// buffer fills, and a search over a large repository fills it in the first
/// few thousand hits.
fn run_log(
    path: &str,
    args: &[String],
    on_spawn: &mut impl FnMut(u32),
    on_progress: &mut impl FnMut(usize),
) -> Result<(Vec<String>, bool)> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Msg(format!("failed to launch git: {e}")))?;
    on_spawn(child.id());

    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(std::result::Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        buf
    });

    let mut oids = Vec::new();
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
            let line = line.trim().to_string();
            if !line.is_empty() {
                oids.push(line);
                if oids.len() % PROGRESS_EVERY == 0 {
                    on_progress(oids.len());
                }
            }
        }
    }

    let status = child.wait().map_err(|e| Error::Msg(e.to_string()))?;
    let errors = stderr_reader.join().unwrap_or_default();
    // A search killed by `cancel_search` exits on a signal, with no code. That
    // is not a failure: the partial result is what the user asked to keep.
    let cancelled = status.code().is_none();
    if !status.success() && !cancelled {
        return Err(Error::Msg(if errors.trim().is_empty() {
            "git log failed".to_string()
        } else {
            errors.trim().to_string()
        }));
    }
    Ok((oids, cancelled))
}

/// Oids that a branch or tag points directly at, for `type:tip`.
fn tip_oids(repo: &Repository) -> HashSet<String> {
    let mut tips = HashSet::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let name = r.name().unwrap_or_default();
            if !(name.starts_with("refs/heads/")
                || name.starts_with("refs/remotes/")
                || name.starts_with("refs/tags/"))
            {
                continue;
            }
            // An annotated tag's target is the tag object, not the commit.
            if let Ok(commit) = r.peel_to_commit() {
                tips.insert(commit.id().to_string());
            }
        }
    }
    tips
}

/// Execute a parsed query. `limit` of 0 means unbounded.
pub fn execute(
    repo: &Repository,
    path: &str,
    query: &Query,
    opts: &SearchOptions,
    limit: usize,
    mut on_spawn: impl FnMut(u32),
    mut on_progress: impl FnMut(usize),
) -> Result<Outcome> {
    let plan = build(query, opts, current_identity(repo).as_deref(), repo.head().is_ok())?;
    let mut outcome = Outcome { notes: plan.notes.clone(), ..Outcome::default() };
    // Nothing to walk, and `git log` calls that fatal rather than empty.
    if plan.direct.is_none() && repo.is_empty().unwrap_or(false) {
        return Ok(outcome);
    }
    // §6: a shallow clone can only answer file and content questions about the
    // history it fetched. Saying nothing turns a partial answer into a
    // confident miss.
    if repo.path().join("shallow").exists()
        && query.terms.iter().any(|t| matches!(t.op, Operator::File | Operator::Change))
    {
        outcome
            .notes
            .push("Shallow clone — file and change searches only see fetched history.".into());
    }

    let mut oids: Vec<String> = if let Some(direct) = &plan.direct {
        let mut found = Vec::new();
        for rev in direct {
            match repo.revparse_single(rev).and_then(|obj| obj.peel_to_commit()) {
                Ok(commit) => found.push(commit.id().to_string()),
                Err(_) => outcome.notes.push(format!("no commit matches '{rev}'")),
            }
        }
        found
    } else {
        let (found, cancelled) = run_log(path, &plan.args, &mut on_spawn, &mut on_progress)?;
        outcome.cancelled = cancelled;
        found
    };

    if let Some(neg) = &plan.negative {
        let (excluded, cancelled) = run_log(path, neg, &mut on_spawn, &mut on_progress)?;
        outcome.cancelled = outcome.cancelled || cancelled;
        let excluded: HashSet<String> = excluded.into_iter().collect();
        oids.retain(|oid| !excluded.contains(oid));
    }

    for filter in &plan.post {
        match filter {
            Post::Tip => {
                let tips = tip_oids(repo);
                oids.retain(|oid| tips.contains(oid));
            }
            Post::CommitPrefix(prefix) => oids.retain(|oid| oid.starts_with(prefix)),
        }
    }

    if limit > 0 && oids.len() > limit {
        oids.truncate(limit);
        outcome.truncated = true;
    }
    outcome.oids = oids;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    fn q(input: &str) -> Query {
        parse(input).unwrap()
    }

    fn args_of(input: &str) -> Vec<String> {
        build(&q(input), &SearchOptions::default(), Some("me@example.com"), true).unwrap().args
    }

    fn run(repo: &TestRepo, input: &str) -> Vec<String> {
        run_with(repo, input, &SearchOptions::default())
    }

    fn run_with(repo: &TestRepo, input: &str, opts: &SearchOptions) -> Vec<String> {
        let path = repo.dir.path().to_str().unwrap();
        execute(&repo.repo, path, &q(input), opts, 0, |_| {}, |_| {}).unwrap().oids
    }

    /// Every operator and alias in §3 parses to the same term.
    #[test]
    fn every_operator_and_alias_parses() {
        let cases: &[(&str, Operator)] = &[
            ("message:x", Operator::Message),
            ("=:x", Operator::Message),
            ("x", Operator::Message),
            ("-message:x", Operator::NotMessage),
            ("author:x", Operator::Author),
            ("@:x", Operator::Author),
            ("committer:x", Operator::Committer),
            ("commit:x", Operator::Commit),
            ("#:x", Operator::Commit),
            ("file:x", Operator::File),
            ("?:x", Operator::File),
            ("change:x", Operator::Change),
            ("~:x", Operator::Change),
            ("type:merge", Operator::Type),
            ("is:merge", Operator::Type),
            ("after:x", Operator::After),
            ("since:x", Operator::After),
            (">:x", Operator::After),
            ("before:x", Operator::Before),
            ("until:x", Operator::Before),
            ("<:x", Operator::Before),
            ("ref:x", Operator::Ref),
            ("^:x", Operator::Ref),
        ];
        for (input, op) in cases {
            let parsed = q(input);
            assert_eq!(parsed.terms.len(), 1, "{input} should be one term");
            assert_eq!(parsed.terms[0].op, *op, "{input}");
        }
    }

    #[test]
    fn quoted_values_survive_and_are_never_operators() {
        let parsed = q(r#"message:"two words" "fix: thing" author:"A B""#);
        assert_eq!(
            parsed.terms,
            vec![
                Term { op: Operator::Message, value: "two words".into() },
                Term { op: Operator::Message, value: "fix: thing".into() },
                Term { op: Operator::Author, value: "A B".into() },
            ]
        );
    }

    #[test]
    fn an_unknown_operator_is_a_parse_error_but_a_url_is_not() {
        let err = parse("athor:me").unwrap_err().to_string();
        assert!(err.contains("unknown operator 'athor:'"), "{err}");
        // Prose and URLs must still search as text, or the field rejects half
        // of what users paste into it.
        assert_eq!(q("https://example.com/x").terms.len(), 1);
        assert_eq!(q("a-very-long-prefix:x").terms.len(), 1);
        assert!(parse("type:branch").is_err(), "type: validates its value");
    }

    #[test]
    fn a_half_typed_operator_is_dropped_rather_than_rejected() {
        // The field searches as you type; `author:` is a query in progress.
        assert_eq!(q("author:").terms.len(), 0);
        assert_eq!(q("fix author:").terms.len(), 1);
    }

    /// The security rule of §3.1: a value beginning with `-` never reaches git
    /// as its own argv word. Checked for every operator, not just the two that
    /// reject it — the others must be *attached* to their flag.
    #[test]
    fn no_operator_lets_a_leading_dash_reach_git_as_an_option() {
        let evil = "--upload-pack=touch/pwned";
        let operators = [
            "message:", "-message:", "author:", "committer:", "file:", "change:", "after:",
            "before:",
        ];
        for op in operators {
            let query = q(&format!("{op}{evil}"));
            let plan = build(&query, &SearchOptions::default(), None, true).unwrap();
            let mut all = plan.args.clone();
            all.extend(plan.negative.unwrap_or_default());
            // Either it never appears as a bare word, or it appears only after
            // `--`, where git treats it as a pathspec.
            if let Some(at) = all.iter().position(|a| a == evil) {
                let sep = all.iter().position(|a| a == "--").unwrap_or(usize::MAX);
                assert!(at > sep, "{op}{evil} reached argv as an option: {all:?}");
            }
        }
        for op in ["ref:", "commit:"] {
            let query = q(&format!("{op}{evil}"));
            let err = build(&query, &SearchOptions::default(), None, true).unwrap_err().to_string();
            assert!(err.contains("starts with '-'"), "{op} must reject it: {err}");
        }
    }

    #[test]
    fn regex_mode_switches_between_fixed_strings_and_ere() {
        assert!(args_of("a.b").contains(&"--fixed-strings".to_string()));
        let opts = SearchOptions { match_regex: true, ..SearchOptions::default() };
        let args = build(&q("a.b"), &opts, None, true).unwrap().args;
        assert!(args.contains(&"--extended-regexp".to_string()));
        assert!(!args.contains(&"--fixed-strings".to_string()));
    }

    #[test]
    fn whole_word_adds_boundaries_and_escapes_the_value() {
        let opts = SearchOptions { match_whole_word: true, ..SearchOptions::default() };
        let args = build(&q("a.b"), &opts, None, true).unwrap().args;
        assert!(args.contains(&r"--grep=\ba\.b\b".to_string()), "{args:?}");
        assert!(args.contains(&"--extended-regexp".to_string()), "boundaries need regex mode");
    }

    #[test]
    fn match_case_and_match_all_map_to_their_flags() {
        assert!(args_of("a b").contains(&"--regexp-ignore-case".to_string()));
        let cased = SearchOptions { match_case: true, ..SearchOptions::default() };
        assert!(!build(&q("a b"), &cased, None, true).unwrap().args.contains(&"--regexp-ignore-case".to_string()));
        let all = SearchOptions { match_all: true, ..SearchOptions::default() };
        assert!(build(&q("a b"), &all, None, true).unwrap().args.contains(&"--all-match".to_string()));
        assert!(!args_of("a b").contains(&"--all-match".to_string()));
    }

    #[test]
    fn at_me_resolves_to_the_configured_identity() {
        assert!(args_of("author:@me").contains(&"--author=me@example.com".to_string()));
        // With no identity configured the term is left alone rather than
        // silently matching everyone.
        let args = build(&q("author:@me"), &SearchOptions::default(), None, true).unwrap().args;
        assert!(args.contains(&"--author=@me".to_string()));
    }

    #[test]
    fn change_uses_the_pickaxe_and_g_only_in_regex_mode() {
        assert!(args_of("change:foo").contains(&"-Sfoo".to_string()));
        let opts = SearchOptions { match_regex: true, ..SearchOptions::default() };
        assert!(build(&q("change:foo"), &opts, None, true).unwrap().args.contains(&"-Gfoo".to_string()));
        assert!(q("change:foo").is_expensive(), "pickaxe must be flagged expensive");
        assert!(!q("message:foo").is_expensive());
    }

    #[test]
    fn ref_replaces_the_default_seeds_and_files_become_a_pathspec() {
        let args = args_of("ref:main file:src/a.rs");
        assert!(!args.contains(&"--branches".to_string()), "ref: replaces --all: {args:?}");
        assert!(args.contains(&"main".to_string()));
        let sep = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[sep + 1], "src/a.rs");
        // Without ref:, the walk is seeded exactly as `graph::layout` seeds it.
        let default = args_of("x");
        for seed in ["--branches", "--tags", "--remotes", "HEAD"] {
            assert!(default.contains(&seed.to_string()), "missing {seed}: {default:?}");
        }
    }

    #[test]
    fn a_query_of_only_commit_terms_is_a_rev_lookup_not_a_walk() {
        let plan = build(&q("commit:abc123"), &SearchOptions::default(), None, true).unwrap();
        assert_eq!(plan.direct, Some(vec!["abc123".to_string()]));
        assert!(plan.args.is_empty());
        // Mixed with anything else it becomes a filter over the walk instead.
        let plan = build(&q("commit:abc123 fix"), &SearchOptions::default(), None, true).unwrap();
        assert!(plan.direct.is_none());
        assert_eq!(plan.post, vec![Post::CommitPrefix("abc123".into())]);
    }

    /// Trap 1. `--invert-grep` inverts *every* `--grep`, so a mixed query
    /// cannot be one invocation — and must not drop either term.
    #[test]
    fn mixing_positive_and_negative_message_terms_uses_two_walks() {
        let only_negative = build(&q("-message:wip"), &SearchOptions::default(), None, true).unwrap();
        assert!(only_negative.args.contains(&"--invert-grep".to_string()));
        assert!(only_negative.negative.is_none(), "one walk suffices when all terms are negative");

        let mixed = build(&q("message:fix -message:wip"), &SearchOptions::default(), None, true).unwrap();
        assert!(!mixed.args.contains(&"--invert-grep".to_string()), "would invert the positive term");
        let neg = mixed.negative.expect("negative walk");
        assert!(neg.contains(&"--grep=wip".to_string()));
        assert!(neg.contains(&"--branches".to_string()), "subtraction must share the scope");
    }

    #[test]
    fn message_search_finds_commits_and_negation_removes_them() {
        let t = TestRepo::new();
        let a = t.commit("add login", &[]);
        let b = t.commit("fix login", &[a]);
        let c = t.commit("wip fix login", &[b]);

        let hits = run(&t, "login");
        assert_eq!(hits.len(), 3);
        assert_eq!(run(&t, "message:fix").len(), 2);

        let mixed = run(&t, "message:fix -message:wip");
        assert_eq!(mixed, vec![b.to_string()], "neither term may be dropped");
        assert!(!mixed.contains(&c.to_string()));
    }

    #[test]
    fn fixed_strings_is_the_default_so_dots_are_literal() {
        let t = TestRepo::new();
        let a = t.commit("release v1.0", &[]);
        let _b = t.commit("release v1X0", &[a]);
        assert_eq!(run(&t, "v1.0"), vec![a.to_string()], "'.' must not match 'X'");
        let regex = SearchOptions { match_regex: true, ..SearchOptions::default() };
        assert_eq!(run_with(&t, "v1.0", &regex).len(), 2, "regex mode makes '.' a wildcard");
    }

    #[test]
    fn author_and_at_me_and_committer_all_match() {
        let t = TestRepo::new();
        let a = t.commit("only commit", &[]);
        assert_eq!(run(&t, "author:test@example.com"), vec![a.to_string()]);
        assert_eq!(run(&t, "committer:Test"), vec![a.to_string()]);
        // TestRepo signs commits as test@example.com; point the config at it
        // so @me has something to resolve to.
        t.repo.config().unwrap().set_str("user.email", "test@example.com").unwrap();
        assert_eq!(run(&t, "author:@me"), vec![a.to_string()]);
    }

    #[test]
    fn type_merge_and_type_tip_filter_the_walk() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        let c = t.commit("c", &[a]);
        let m = t.commit("m", &[b, c]);
        assert_eq!(run(&t, "type:merge"), vec![m.to_string()]);

        // TestRepo pins every commit with its own branch, so drop the one
        // holding `a` to make it reachable-but-not-a-tip — the only shape in
        // which `type:tip` means anything.
        t.repo.find_branch("b1", git2::BranchType::Local).unwrap().delete().unwrap();
        let tips = run(&t, "type:tip");
        assert!(tips.contains(&m.to_string()), "the merge is a branch tip: {tips:?}");
        assert!(!tips.contains(&a.to_string()), "no ref points at a: {tips:?}");
    }

    #[test]
    fn type_stash_walks_the_stash_reflog_and_nothing_else() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let m = t.commit("m", &[a]);
        t.checkout(m);

        let path = t.dir.path().to_str().unwrap();
        let mut config = t.repo.config().unwrap();
        config.set_str("user.name", "Test User").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        std::fs::write(t.dir.path().join("file.txt"), "dirty").unwrap();
        let stashed = std::process::Command::new("git")
            .args(["-C", path, "stash", "push", "-m", "stashed work"])
            .output()
            .unwrap();
        assert!(stashed.status.success(), "{}", String::from_utf8_lossy(&stashed.stderr));

        let stashes = run(&t, "type:stash");
        assert_eq!(stashes.len(), 1, "exactly the stash commit: {stashes:?}");
        assert!(!stashes.contains(&m.to_string()), "the stash walk must not reach history");
        // The same query without type:stash must not see the stash commit,
        // which is why the seeds are the graph's and not `--all`.
        assert!(!run(&t, "message:stashed").contains(&stashes[0]));
    }

    #[test]
    fn file_and_change_scope_to_content() {
        let t = TestRepo::new();
        // TestRepo writes every commit's message into `file.txt`, so the
        // pickaxe has real content to find.
        let a = t.commit("adds needle", &[]);
        let _b = t.commit("plain", &[a]);
        assert!(run(&t, "file:file.txt").len() >= 2);
        assert_eq!(run(&t, "file:nothing/here.rs").len(), 0);
        let changed = run(&t, "change:needle");
        assert!(changed.contains(&a.to_string()), "pickaxe must find the added string: {changed:?}");
    }

    #[test]
    fn dates_are_handed_to_git_verbatim() {
        let t = TestRepo::new();
        let a = t.commit("old", &[]);
        // TestRepo's signatures start at 2020-09-13 (1_600_000_000).
        assert_eq!(run(&t, "after:2020-01-01 before:2021-01-01"), vec![a.to_string()]);
        assert_eq!(run(&t, "after:2021-01-01").len(), 0);
        // git's own error surfaces rather than a parser of ours.
        let path = t.dir.path().to_str().unwrap();
        let bad = execute(
            &t.repo,
            path,
            &q("after:notadate"),
            &SearchOptions::default(),
            0,
            |_| {},
            |_| {},
        );
        assert!(bad.is_err() || bad.unwrap().oids.is_empty());
    }

    #[test]
    fn the_result_cap_reports_that_it_truncated() {
        let t = TestRepo::new();
        let a = t.commit("x", &[]);
        let b = t.commit("x", &[a]);
        let _c = t.commit("x", &[b]);
        let path = t.dir.path().to_str().unwrap();
        let capped =
            execute(&t.repo, path, &q("x"), &SearchOptions::default(), 2, |_| {}, |_| {}).unwrap();
        assert_eq!(capped.oids.len(), 2);
        assert!(capped.truncated, "truncation is never silent (B4)");
        let full =
            execute(&t.repo, path, &q("x"), &SearchOptions::default(), 0, |_| {}, |_| {}).unwrap();
        assert_eq!(full.oids.len(), 3);
        assert!(!full.truncated);
    }

    #[test]
    fn describe_reads_the_query_back_in_prose() {
        let text = q("author:@me file:src/** after:2026-01-01").describe();
        assert_eq!(text, "by @me, touching src/**, after 2026-01-01");
    }
}
