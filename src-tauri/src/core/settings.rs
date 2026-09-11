//! Persisted application settings (G14).
//!
//! These live in a JSON file under the platform config directory rather than
//! in `localStorage`, for two reasons: `localStorage` is scoped to the WebView
//! and is wiped by anything that clears it, and a settings file is something a
//! user can read, diff and copy to another machine — which is what "settings"
//! means to everyone who has ever managed a `.gitconfig`.
//!
//! Two properties are load-bearing and both are tested:
//!
//! * **A field this version does not understand must not cost the user the
//!   rest of their settings.** Every field deserializes leniently: a value of
//!   the wrong type, or an enum variant from a newer build, falls back to that
//!   one field's default and the others survive. A whole-file `from_str` would
//!   turn one bad key into a factory reset.
//! * **Writes are atomic.** The file is written beside itself and renamed, so
//!   a crash or a full disk mid-write leaves the previous settings intact
//!   rather than a truncated file that reads as "all defaults".

use crate::error::Result;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Deserialize a field, falling back to `fallback` instead of failing the
/// whole file. See the module note.
fn lenient_or<'de, D, T>(deserializer: D, fallback: T) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or(fallback))
}

fn lenient<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    lenient_or(deserializer, T::default())
}

// The fields whose default is not `T::default()` need their own wrapper:
// `deserialize_with` takes no arguments, and `#[serde(default = "...")]` only
// covers a *missing* field, not a present-but-unreadable one. Without these, a
// hand-edited `"fontSize": "big"` would fall back to 0 and then be clamped to
// the minimum — a legible UI, but not the one the user had.
fn lenient_font_size<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u8, D::Error> {
    lenient_or(d, default_font_size())
}
fn lenient_terminal_font_size<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u8, D::Error> {
    lenient_or(d, default_terminal_font_size())
}
fn lenient_tab_width<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u8, D::Error> {
    lenient_or(d, default_tab_width())
}
fn lenient_true<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
    lenient_or(d, true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Compact,
    #[default]
    Normal,
    Comfortable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    #[default]
    Inline,
    Split,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DateStyle {
    #[default]
    Relative,
    Absolute,
}

/// A repo the start screen can draw without opening it. Mirrors the frontend's
/// `RecentRepo`; it moved here so the recent list survives a cleared WebView.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
    pub branch: Option<String>,
}

fn default_font_size() -> u8 {
    13
}
fn default_terminal_font_size() -> u8 {
    12
}
fn default_tab_width() -> u8 {
    4
}
fn default_auto_fetch_minutes() -> u32 {
    1
}
fn default_true() -> bool {
    true
}

/// The columns GitKraken shows by default. `changes` is off because it costs a
/// diff per visible row, and a user who wants it should be the one asking.
pub const GRAPH_COLUMNS: [&str; 4] = ["author", "changes", "date", "sha"];

fn default_graph_columns() -> Vec<String> {
    vec!["author".into(), "date".into(), "sha".into()]
}

/// Keep only known ids, and only once each.
///
/// An unknown id would render as a blank column with no header and no way to
/// remove it, and a duplicate would render the same value twice — both are
/// reachable by hand-editing the file, and neither is worth a broken graph.
fn lenient_columns<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    let raw: Vec<String> = lenient_or(d, default_graph_columns())?;
    let mut out = Vec::new();
    for id in raw {
        if GRAPH_COLUMNS.contains(&id.as_str()) && !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, deserialize_with = "lenient")]
    pub theme: Theme,
    #[serde(default, deserialize_with = "lenient")]
    pub density: Density,
    #[serde(default = "default_font_size", deserialize_with = "lenient_font_size")]
    pub font_size: u8,
    #[serde(default, deserialize_with = "lenient")]
    pub date_style: DateStyle,

    #[serde(default, deserialize_with = "lenient")]
    pub diff_mode: DiffMode,
    #[serde(default, deserialize_with = "lenient")]
    pub diff_ignore_whitespace: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub diff_word_wrap: bool,
    #[serde(default = "default_tab_width", deserialize_with = "lenient_tab_width")]
    pub diff_tab_width: u8,

    /// Where the clone form starts its directory picker.
    #[serde(default, deserialize_with = "lenient")]
    pub default_clone_dir: Option<String>,
    /// Minutes between background fetches; 0 is off. This is the *default* —
    /// `04-pull.md` §2's "default 1, configurable, 0 = off" — and a repository
    /// that has been configured individually keeps its own value.
    #[serde(default = "default_auto_fetch_minutes", deserialize_with = "lenient")]
    pub auto_fetch_minutes: u32,
    /// Append `(cherry picked from commit …)` — `07-cherry-pick.md` B1.
    #[serde(default, deserialize_with = "lenient")]
    pub cherry_pick_append_origin: bool,

    /// Follow renames in file history and the blame reached through it (G22).
    /// Defaults **on**: not following is not a cheaper view of the same
    /// answer, it is a wrong one, and the cost only shows up on the single
    /// commit where the tracked path was added.
    #[serde(default = "default_true", deserialize_with = "lenient_true")]
    pub history_follow_renames: bool,
    /// Tint the blame gutter by how recent each line is (G21).
    #[serde(default = "default_true", deserialize_with = "lenient_true")]
    pub blame_heatmap: bool,

    /// Optional graph columns, in display order (G16). The message column is
    /// not listed: it is always present and always takes the remaining width,
    /// so making it removable would leave the graph with nothing to read.
    #[serde(default = "default_graph_columns", deserialize_with = "lenient_columns")]
    pub graph_columns: Vec<String>,

    #[serde(default = "default_terminal_font_size", deserialize_with = "lenient_terminal_font_size")]
    pub terminal_font_size: u8,
    /// Empty means "the login shell".
    #[serde(default, deserialize_with = "lenient")]
    pub terminal_shell: Option<String>,

    /// Action id -> chord, for the actions the user has rebound. Only
    /// overrides are stored, so a changed default reaches everyone who has not
    /// deliberately moved that action.
    #[serde(default, deserialize_with = "lenient")]
    pub keybindings: BTreeMap<String, String>,

    #[serde(default, deserialize_with = "lenient")]
    pub recent_repos: Vec<RecentRepo>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            density: Density::default(),
            font_size: default_font_size(),
            date_style: DateStyle::default(),
            diff_mode: DiffMode::default(),
            diff_ignore_whitespace: false,
            diff_word_wrap: false,
            diff_tab_width: default_tab_width(),
            default_clone_dir: None,
            auto_fetch_minutes: default_auto_fetch_minutes(),
            cherry_pick_append_origin: false,
            history_follow_renames: true,
            blame_heatmap: true,
            graph_columns: default_graph_columns(),
            terminal_font_size: default_terminal_font_size(),
            terminal_shell: None,
            keybindings: BTreeMap::new(),
            recent_repos: Vec::new(),
        }
    }
}

impl Settings {
    /// Clamp the values that drive CSS and a pty, so a hand-edited file cannot
    /// produce a 2px UI or a zero-column terminal.
    fn clamp(&mut self) {
        self.font_size = self.font_size.clamp(10, 20);
        self.terminal_font_size = self.terminal_font_size.clamp(8, 24);
        self.diff_tab_width = self.diff_tab_width.clamp(1, 16);
        // A fetch every few seconds is a request storm, not a preference.
        if self.auto_fetch_minutes != 0 {
            self.auto_fetch_minutes = self.auto_fetch_minutes.clamp(1, 1440);
        }
    }
}

/// The settings file inside `dir` (the app's config directory).
pub fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// Read settings, falling back to defaults.
///
/// This never fails. Settings are read on the way to drawing the first frame,
/// and a preferences file is not worth refusing to start over — the worst
/// honest outcome is the default UI. A file that cannot be parsed *at all* is
/// moved aside first, so the next write does not destroy whatever the user had
/// in there.
pub fn load(dir: &Path) -> Settings {
    let path = settings_path(dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    let mut settings = match serde_json::from_str::<Settings>(&text) {
        Ok(settings) => settings,
        Err(_) => {
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            Settings::default()
        }
    };
    settings.clamp();
    settings
}

/// Write settings atomically. Creates `dir` if it does not exist.
pub fn save(dir: &Path, settings: &Settings) -> Result<Settings> {
    let mut settings = settings.clone();
    settings.clamp();
    std::fs::create_dir_all(dir)?;
    let path = settings_path(dir);
    // Same directory as the target: `rename` is only atomic within a
    // filesystem, and the system temp dir is routinely a different one.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(&settings).unwrap_or_default())?;
    std::fs::rename(&temp, &path)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn missing_file_reads_as_defaults() {
        let dir = TempDir::new().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
    }

    #[test]
    fn a_saved_file_round_trips() {
        let dir = TempDir::new().unwrap();
        let mut settings = Settings {
            theme: Theme::Light,
            density: Density::Compact,
            font_size: 15,
            ..Settings::default()
        };
        settings.keybindings.insert("commit".into(), "Mod+Enter".into());
        settings.recent_repos.push(RecentRepo {
            path: "/a".into(),
            name: "a".into(),
            last_opened: 42,
            branch: Some("main".into()),
        });

        save(dir.path(), &settings).unwrap();
        assert_eq!(load(dir.path()), settings);
    }

    #[test]
    fn one_unreadable_field_does_not_cost_the_others() {
        // The case this protects: a settings file written by a newer build,
        // or hand-edited. A whole-file parse would turn "theme: dusk" into a
        // factory reset of every other preference.
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            settings_path(dir.path()),
            r#"{ "theme": "dusk", "fontSize": "big", "density": "compact", "diffMode": "split" }"#,
        )
        .unwrap();

        let loaded = load(dir.path());
        assert_eq!(loaded.density, Density::Compact, "valid fields survive");
        assert_eq!(loaded.diff_mode, DiffMode::Split);
        assert_eq!(loaded.theme, Theme::System, "unknown variant falls back");
        assert_eq!(loaded.font_size, 13, "wrong type falls back");
    }

    /// A hand-edited column list must not be able to produce a column with no
    /// header, or the same column twice.
    #[test]
    fn unknown_and_duplicate_graph_columns_are_dropped() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            settings_path(dir.path()),
            r#"{ "graphColumns": ["sha", "wat", "sha", "author"] }"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()).graph_columns, vec!["sha", "author"]);
    }

    #[test]
    fn an_empty_graph_column_list_is_respected() {
        // "Only the message" is a legitimate choice, and coercing it back to
        // the defaults would make the checkboxes un-uncheckable.
        let dir = TempDir::new().unwrap();
        std::fs::write(settings_path(dir.path()), r#"{ "graphColumns": [] }"#).unwrap();
        assert!(load(dir.path()).graph_columns.is_empty());
    }

    #[test]
    fn a_file_that_is_not_json_is_kept_rather_than_overwritten() {
        let dir = TempDir::new().unwrap();
        std::fs::write(settings_path(dir.path()), "not json at all").unwrap();

        assert_eq!(load(dir.path()), Settings::default());
        let backup = dir.path().join("settings.json.bak");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "not json at all");
    }

    #[test]
    fn values_that_drive_css_and_a_pty_are_clamped_on_both_sides() {
        let dir = TempDir::new().unwrap();
        let settings = Settings {
            font_size: 200,
            terminal_font_size: 1,
            diff_tab_width: 0,
            auto_fetch_minutes: 99_999,
            ..Settings::default()
        };
        let saved = save(dir.path(), &settings).unwrap();

        assert_eq!(saved.font_size, 20);
        assert_eq!(saved.terminal_font_size, 8);
        assert_eq!(saved.diff_tab_width, 1);
        assert_eq!(saved.auto_fetch_minutes, 1440);
        assert_eq!(load(dir.path()), saved);
    }

    #[test]
    fn auto_fetch_off_stays_off() {
        // 0 is "off", not "as fast as possible" — clamping it to a minimum of
        // 1 would silently turn the feature on for everyone who disabled it.
        let dir = TempDir::new().unwrap();
        let settings = Settings {
            auto_fetch_minutes: 0,
            ..Settings::default()
        };
        assert_eq!(save(dir.path(), &settings).unwrap().auto_fetch_minutes, 0);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_settings_readable() {
        let dir = TempDir::new().unwrap();
        let first = Settings {
            font_size: 16,
            ..Settings::default()
        };
        save(dir.path(), &first).unwrap();

        // A directory where the temp file wants to be: `write` fails, and the
        // rename never happens, so the live file is untouched.
        std::fs::create_dir_all(settings_path(dir.path()).with_extension("json.tmp")).unwrap();
        let second = Settings {
            font_size: 11,
            ..Settings::default()
        };
        assert!(save(dir.path(), &second).is_err());
        assert_eq!(load(dir.path()).font_size, 16);
    }
}
