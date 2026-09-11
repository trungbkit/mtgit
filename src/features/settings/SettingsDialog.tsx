import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { getIdentity, setIdentity } from "../../ipc/commands";
import type { Density, IdentityInfo, IdentityScope, Settings, Theme } from "../../ipc/types";
import { ACTIONS, chordFromEvent, formatChord, validateChord, type ActionId } from "../../lib/keys";
import { useSession } from "../../stores/session";
import { useSettings } from "../../stores/settings";
import { toastError, useToasts } from "../../stores/toasts";
import "./settings.css";

type Tab = "general" | "appearance" | "git" | "terminal" | "shortcuts";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "git", label: "Git" },
  { id: "terminal", label: "Terminal" },
  { id: "shortcuts", label: "Shortcuts" },
];

/**
 * The settings screen (G14).
 *
 * A purpose-built panel rather than a `promptDialog` per preference, for the
 * reason `CloneDialog` is one: the generic host answers one question, and this
 * is thirty of them. Every control writes through `useSettings.set`, which is
 * optimistic and debounced — there is no Save button, and no way to lose a
 * change by closing the window.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("general");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => panelRef.current?.focus(), []);

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={panelRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="settings-head">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose} aria-label="Close settings">
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-tab${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === "general" && <GeneralTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "git" && <GitTab />}
            {tab === "terminal" && <TerminalTab />}
            {tab === "shortcuts" && <ShortcutsTab />}
          </div>
        </div>
        <div className="settings-foot">
          <span className="settings-hint">
            Saved automatically to the app's settings file.
          </span>
          <button onClick={() => useSettings.getState().reset()}>Restore defaults</button>
        </div>
      </div>
    </div>
  );
}

// ---- shared controls --------------------------------------------------------

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="settings-row">
      <span className="settings-row-label">
        {label}
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      <span className="settings-row-control">{children}</span>
    </label>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-choice" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          className={`settings-seg${value === option.value ? " active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function useSetting<K extends keyof Settings>(key: K): [Settings[K], (value: Settings[K]) => void] {
  const value = useSettings((s) => s.settings[key]);
  return [value, (next) => useSettings.getState().set({ [key]: next } as Partial<Settings>)];
}

function Toggle({ setting, label, hint }: { setting: keyof Settings; label: string; hint?: string }) {
  const [value, set] = useSetting(setting);
  return (
    <Row label={label} hint={hint}>
      <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked as never)} />
    </Row>
  );
}

// ---- tabs -------------------------------------------------------------------

function GeneralTab() {
  const [cloneDir, setCloneDir] = useSetting("defaultCloneDir");
  const [autoFetch, setAutoFetch] = useSetting("autoFetchMinutes");

  async function pickDir() {
    const chosen = await openDialog({ directory: true, multiple: false });
    if (typeof chosen === "string") setCloneDir(chosen);
  }

  return (
    <section>
      <h3>Repositories</h3>
      <Row label="Default clone directory" hint="Where the clone form starts.">
        <span className="settings-path">
          <input
            value={cloneDir ?? ""}
            placeholder="Ask each time"
            onChange={(e) => setCloneDir(e.target.value || null)}
          />
          <button onClick={pickDir}>Browse…</button>
        </span>
      </Row>
      <Row
        label="Auto-fetch every"
        hint="0 turns it off. A repository can still override this from the fetch menu."
      >
        <span className="settings-number">
          <input
            type="number"
            min={0}
            max={1440}
            value={autoFetch}
            onChange={(e) => setAutoFetch(Math.max(0, Number(e.target.value) || 0))}
          />
          <span>minutes</span>
        </span>
      </Row>

      <h3>Commits</h3>
      <Toggle
        setting="cherryPickAppendOrigin"
        label="Record the source of a cherry-pick"
        hint="Adds git's own “(cherry picked from commit …)” line."
      />

      <h3>History</h3>
      <Toggle
        setting="historyFollowRenames"
        label="Follow renames in file history"
        hint="Off, history stops at the commit that moved the file — and so does the blame you reach from it."
      />
      <Toggle
        setting="blameHeatmap"
        label="Tint blame by line age"
        hint="Warmer gutter for lines changed recently, relative to the rest of the file."
      />
    </section>
  );
}

function AppearanceTab() {
  const [theme, setTheme] = useSetting("theme");
  const [density, setDensity] = useSetting("density");
  const [fontSize, setFontSize] = useSetting("fontSize");
  const [dateStyle, setDateStyle] = useSetting("dateStyle");
  const [diffMode, setDiffMode] = useSetting("diffMode");
  const [tabWidth, setTabWidth] = useSetting("diffTabWidth");

  return (
    <section>
      <h3>Theme</h3>
      <Row label="Colour theme">
        <Choice<Theme>
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Row>
      <Row label="Density" hint="Row height in the graph and the sidebar.">
        <Choice<Density>
          value={density}
          onChange={setDensity}
          options={[
            { value: "compact", label: "Compact" },
            { value: "normal", label: "Normal" },
            { value: "comfortable", label: "Comfortable" },
          ]}
        />
      </Row>
      <Row label="Interface font size">
        <span className="settings-number">
          <input
            type="range"
            min={10}
            max={20}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
          <span>{fontSize}px</span>
        </span>
      </Row>
      <Row label="Dates">
        <Choice
          value={dateStyle}
          onChange={setDateStyle}
          options={[
            { value: "relative", label: "Relative" },
            { value: "absolute", label: "Absolute" },
          ]}
        />
      </Row>

      <h3>Diff</h3>
      <Row label="Default view">
        <Choice
          value={diffMode}
          onChange={setDiffMode}
          options={[
            { value: "inline", label: "Inline" },
            { value: "split", label: "Split" },
          ]}
        />
      </Row>
      <Toggle setting="diffIgnoreWhitespace" label="Ignore whitespace changes" />
      <Toggle setting="diffWordWrap" label="Wrap long lines" />
      <Row label="Tab width">
        <span className="settings-number">
          <input
            type="number"
            min={1}
            max={16}
            value={tabWidth}
            onChange={(e) => setTabWidth(Math.max(1, Number(e.target.value) || 1))}
          />
          <span>spaces</span>
        </span>
      </Row>
    </section>
  );
}

/**
 * Git identity, at both levels.
 *
 * This reads and writes git's own config rather than the settings file, so a
 * commit made from the terminal panel carries the same author — see
 * `core/identity.rs`. An empty field *removes* the override rather than
 * writing an empty identity.
 */
function GitTab() {
  const repo = useSession((s) => s.repo);
  const pushToast = useToasts((s) => s.push);
  const [info, setInfo] = useState<IdentityInfo | null>(null);
  const [draft, setDraft] = useState<Record<IdentityScope, { name: string; email: string }>>({
    global: { name: "", email: "" },
    repo: { name: "", email: "" },
  });

  useEffect(() => {
    let cancelled = false;
    getIdentity(repo?.path)
      .then((loaded) => {
        if (cancelled) return;
        setInfo(loaded);
        setDraft({
          global: { name: loaded.globalName ?? "", email: loaded.globalEmail ?? "" },
          repo: { name: loaded.repoName ?? "", email: loaded.repoEmail ?? "" },
        });
      })
      .catch(toastError);
    return () => {
      cancelled = true;
    };
  }, [repo?.path]);

  async function save(scope: IdentityScope) {
    const { name, email } = draft[scope];
    try {
      const updated = await setIdentity(scope, name, email, repo?.path);
      setInfo(updated);
      pushToast("success", scope === "global" ? "Global identity saved." : "Repository identity saved.");
    } catch (e) {
      toastError(e);
    }
  }

  function field(scope: IdentityScope, key: "name" | "email", value: string) {
    setDraft((d) => ({ ...d, [scope]: { ...d[scope], [key]: value } }));
  }

  return (
    <section>
      <h3>Global identity</h3>
      <p className="settings-note">
        Written to your <code>~/.gitconfig</code>, exactly as <code>git config --global</code> would.
      </p>
      <Row label="Name">
        <input value={draft.global.name} onChange={(e) => field("global", "name", e.target.value)} />
      </Row>
      <Row label="Email">
        <input value={draft.global.email} onChange={(e) => field("global", "email", e.target.value)} />
      </Row>
      <div className="settings-actions">
        <button className="primary" onClick={() => save("global")}>
          Save global identity
        </button>
      </div>

      <h3>This repository</h3>
      {repo ? (
        <>
          <p className="settings-note">
            An override for <code>{repo.name}</code>. Leave both fields empty to inherit the global
            identity. Commits here are currently authored as{" "}
            <strong>
              {info?.effectiveName ?? "no name set"}
              {info?.effectiveEmail ? ` <${info.effectiveEmail}>` : ""}
            </strong>
            .
          </p>
          <Row label="Name">
            <input value={draft.repo.name} onChange={(e) => field("repo", "name", e.target.value)} />
          </Row>
          <Row label="Email">
            <input value={draft.repo.email} onChange={(e) => field("repo", "email", e.target.value)} />
          </Row>
          <div className="settings-actions">
            <button className="primary" onClick={() => save("repo")}>
              Save repository identity
            </button>
          </div>
        </>
      ) : (
        <p className="settings-note">Open a repository to set an identity just for it.</p>
      )}
    </section>
  );
}

function TerminalTab() {
  const [fontSize, setFontSize] = useSetting("terminalFontSize");
  const [shell, setShell] = useSetting("terminalShell");
  return (
    <section>
      <h3>Terminal</h3>
      <Row label="Font size">
        <span className="settings-number">
          <input
            type="range"
            min={8}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
          <span>{fontSize}px</span>
        </span>
      </Row>
      <Row label="Shell" hint="Leave empty to use your login shell.">
        <input
          value={shell ?? ""}
          placeholder="/bin/zsh"
          onChange={(e) => setShell(e.target.value || null)}
        />
      </Row>
      <p className="settings-note">A new terminal session picks these up; open ones keep theirs.</p>
    </section>
  );
}

/** Rebinding. The read-only cheat sheet is `ShortcutsOverlay`, on `?`. */
function ShortcutsTab() {
  const overrides = useSettings((s) => s.settings.keybindings);
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  function rebind(id: ActionId, event: React.KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(null);
      setError(null);
      return;
    }
    const chord = chordFromEvent(event.nativeEvent);
    if (!chord) return;
    const problem = validateChord(chord, id);
    if (problem) {
      setError(problem);
      return;
    }
    useSettings.getState().set({ keybindings: { ...overrides, [id]: chord } });
    setCapturing(null);
    setError(null);
  }

  function clear(id: ActionId) {
    const { [id]: _removed, ...rest } = overrides;
    useSettings.getState().set({ keybindings: rest });
  }

  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  return (
    <section>
      {groups.map((group) => (
        <div key={group}>
          <h3>{group}</h3>
          {ACTIONS.filter((a) => a.group === group).map((action) => {
            const chord = overrides[action.id] || action.chord;
            const customised = !!overrides[action.id];
            return (
              <div className="settings-row" key={action.id}>
                <span className="settings-row-label">
                  {action.label}
                  {action.note && <span className="settings-row-hint">{action.note}</span>}
                </span>
                <span className="settings-row-control settings-bind">
                  <button
                    className={`settings-chord${capturing === action.id ? " capturing" : ""}`}
                    onClick={() => {
                      setCapturing(action.id);
                      setError(null);
                    }}
                    onKeyDown={(e) => capturing === action.id && rebind(action.id, e)}
                  >
                    {capturing === action.id ? "Press keys…" : formatChord(chord)}
                  </button>
                  {action.also?.map((alt) => (
                    <span className="settings-chord-alt" key={alt}>
                      {formatChord(alt)}
                    </span>
                  ))}
                  <button
                    className="settings-reset"
                    disabled={!customised}
                    onClick={() => clear(action.id)}
                    title="Restore the default"
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {error && <p className="settings-error">{error}</p>}
      <p className="settings-note">
        Press Escape while capturing to leave a shortcut as it is. Greyed chords beside a shortcut
        are fixed alternates.
      </p>
    </section>
  );
}
