import { useMemo, useState } from "react";
import type { FileStatus } from "../../ipc/types";
import { Icon } from "../../components/Icon";
import "./filelist.css";

export interface FileItem {
  path: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
  size?: number | null;
}

/**
 * One mapping from status to mark and colour, for the rows *and* the change
 * summary above them. A second copy of "what colour is a modified file" is the
 * shape defect the settings convention is about.
 */
export const STATUS_MARK: Record<FileStatus, { ch: string; cls: string }> = {
  added: { ch: "A", cls: "add" },
  untracked: { ch: "U", cls: "add" },
  modified: { ch: "M", cls: "mod" },
  deleted: { ch: "D", cls: "del" },
  renamed: { ch: "R", cls: "mod" },
  copied: { ch: "C", cls: "mod" },
  typechange: { ch: "T", cls: "mod" },
  conflicted: { ch: "!", cls: "del" },
  unknown: { ch: "?", cls: "mod" },
};

/** How the flat list is ordered. `path` is the order the commit gives. */
type SortMode = "path" | "status" | "name";

const SORT_LABEL: Record<SortMode, string> = {
  path: "Path order",
  status: "By status",
  name: "By name",
};

const NEXT_SORT: Record<SortMode, SortMode> = {
  path: "status",
  status: "name",
  name: "path",
};

function sortFiles(files: FileItem[], mode: SortMode): FileItem[] {
  if (mode === "path") return files;
  const copy = [...files];
  if (mode === "name") {
    copy.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  } else {
    // Grouped by mark, so every added file sits together — which is the
    // question this order answers ("what did this commit *add*").
    copy.sort(
      (a, b) =>
        STATUS_MARK[a.status].ch.localeCompare(STATUS_MARK[b.status].ch) ||
        a.path.localeCompare(b.path),
    );
  }
  return copy;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function FileList({
  files,
  selected,
  onSelect,
  renderActions,
  onContextMenu,
}: {
  files: FileItem[];
  selected: string | null;
  onSelect: (path: string) => void;
  renderActions?: (f: FileItem) => React.ReactNode;
  onContextMenu?: (event: React.MouseEvent, file: FileItem) => void;
}) {
  const [tree, setTree] = useState(false);
  // Per-view, not persisted: `core/settings.rs` should not grow an entry for
  // how one panel happened to be sorted a minute ago.
  const [sort, setSort] = useState<SortMode>("path");
  const ordered = useMemo(() => sortFiles(files, sort), [files, sort]);

  return (
    <div className="filelist">
      <div className="filelist-head">
        <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
        {/* Hidden rather than disabled in tree mode: the tree imposes its own
            order (directories first, then name), so a sort control there would
            be a button that changes nothing. */}
        {!tree && (
          <button
            className="filelist-sort"
            title={`${SORT_LABEL[sort]} — click for ${SORT_LABEL[NEXT_SORT[sort]].toLowerCase()}`}
            onClick={() => setSort(NEXT_SORT[sort])}
          >
            <Icon name="sort" size={11} />
            {SORT_LABEL[sort]}
          </button>
        )}
        <div className="pathtree-toggle">
          <button className={tree ? "" : "on"} onClick={() => setTree(false)}>
            Path
          </button>
          <button className={tree ? "on" : ""} onClick={() => setTree(true)}>
            Tree
          </button>
        </div>
      </div>
      {tree ? (
        <TreeView files={files} selected={selected} onSelect={onSelect} renderActions={renderActions} onContextMenu={onContextMenu} />
      ) : (
        <div className="filelist-items">
          {ordered.map((f) => (
            <FileRow
              key={f.path}
              f={f}
              label={f.path}
              indent={0}
              selected={selected === f.path}
              onSelect={onSelect}
              renderActions={renderActions}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({
  f,
  label,
  indent,
  selected,
  onSelect,
  renderActions,
  onContextMenu,
}: {
  f: FileItem;
  label: string;
  indent: number;
  selected: boolean;
  onSelect: (path: string) => void;
  renderActions?: (f: FileItem) => React.ReactNode;
  onContextMenu?: (event: React.MouseEvent, file: FileItem) => void;
}) {
  const mark = STATUS_MARK[f.status];
  // In tree mode the label is already a basename, so `cut` is -1 and the
  // directory span is simply absent — the same code, not a missing branch.
  const cut = label.lastIndexOf("/");
  return (
    <div
      className={`file-row${selected ? " selected" : ""}`}
      style={{ paddingLeft: 10 + indent * 14 }}
      onClick={() => onSelect(f.path)}
      onContextMenu={(event) => onContextMenu?.(event, f)}
      title={f.path}
    >
      <span className={`file-mark ${mark.cls}`}>{mark.ch}</span>
      <span className="file-name">
        {cut >= 0 && <span className="file-dir">{label.slice(0, cut + 1)}</span>}
        <b>{label.slice(cut + 1)}</b>
      </span>
      {f.size != null && f.size >= 1024 * 1024 && <span className="file-size">{formatSize(f.size)}</span>}
      {renderActions && <span className="file-actions">{renderActions(f)}</span>}
    </div>
  );
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(size / 1024)} KB`;
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file?: FileItem;
}

function TreeView({
  files,
  selected,
  onSelect,
  renderActions,
  onContextMenu,
}: {
  files: FileItem[];
  selected: string | null;
  onSelect: (path: string) => void;
  renderActions?: (f: FileItem) => React.ReactNode;
  onContextMenu?: (event: React.MouseEvent, file: FileItem) => void;
}) {
  const root = useMemo(() => buildTree(files), [files]);
  return <div className="filelist-items">{renderNode(root, 0, selected, onSelect, renderActions, onContextMenu)}</div>;
}

function buildTree(files: FileItem[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map() });
      node = node.children.get(part)!;
      if (i === parts.length - 1) node.file = f;
    });
  }
  return root;
}

function renderNode(
  node: TreeNode,
  depth: number,
  selected: string | null,
  onSelect: (path: string) => void,
  renderActions?: (f: FileItem) => React.ReactNode,
  onContextMenu?: (event: React.MouseEvent, file: FileItem) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const entries = [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 ? 0 : 1;
    const bDir = b.children.size > 0 ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });
  for (const child of entries) {
    if (child.file && child.children.size === 0) {
      out.push(
        <FileRow
          key={child.file.path}
          f={child.file}
          label={child.name}
          indent={depth}
          selected={selected === child.file.path}
          onSelect={onSelect}
          renderActions={renderActions}
          onContextMenu={onContextMenu}
        />,
      );
    } else {
      out.push(
        <div key={`dir-${depth}-${child.name}`} className="tree-dir" style={{ paddingLeft: 10 + depth * 14 }}>
          {child.name}/
        </div>,
      );
        out.push(...renderNode(child, depth + 1, selected, onSelect, renderActions, onContextMenu));
    }
  }
  return out;
}
