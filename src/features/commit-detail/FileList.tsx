import { useMemo, useState } from "react";
import type { FileStatus } from "../../ipc/types";
import "./filelist.css";

export interface FileItem {
  path: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
  size?: number | null;
}

const STATUS_MARK: Record<FileStatus, { ch: string; cls: string }> = {
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

  return (
    <div className="filelist">
      <div className="filelist-head">
        <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
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
          {files.map((f) => (
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
  return (
    <div
      className={`file-row${selected ? " selected" : ""}`}
      style={{ paddingLeft: 10 + indent * 14 }}
      onClick={() => onSelect(f.path)}
      onContextMenu={(event) => onContextMenu?.(event, f)}
    >
      <span className={`file-mark ${mark.cls}`}>{mark.ch}</span>
      <span className="file-name">{label}</span>
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
