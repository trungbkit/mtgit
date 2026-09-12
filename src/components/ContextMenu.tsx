import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./contextmenu.css";

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Render a divider instead of a clickable row. */
  separator?: boolean;
  /**
   * Render a non-interactive section title instead of a clickable row. The
   * graph's row menu acts on two objects at once — the commit and each ref
   * sitting on it — and a separator alone does not say which half you are in.
   */
  header?: string;
  /** Nested items, shown on hover. */
  submenu?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Gap kept between the menu and the window edge when it has to be nudged. */
const EDGE_PAD = 6;

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  /**
   * Where the menu actually lands.
   *
   * A `position: fixed` menu painted at the raw pointer coordinates runs off
   * the bottom of the window as soon as it is opened near it — and a context
   * menu that has grown past a dozen entries is opened near it often. It is
   * measured after the first paint and then flipped or nudged back inside;
   * `max-height` in the stylesheet catches the case where it does not fit at
   * all, so a long menu scrolls rather than losing its last entries.
   */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) {
      setAt(null);
      return;
    }
    const el = root.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxX = window.innerWidth - EDGE_PAD;
    const maxY = window.innerHeight - EDGE_PAD;
    // Flip rather than clamp horizontally: a menu nudged left of the pointer
    // covers the row it was raised from, and the pointer is already there.
    const x = menu.x + width > maxX ? Math.max(EDGE_PAD, menu.x - width) : menu.x;
    const y = menu.y + height > maxY ? Math.max(EDGE_PAD, maxY - height) : menu.y;
    setAt({ x, y });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    );
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      ref={root}
      className="context-menu"
      role="menu"
      // Hidden for the one frame between paint and measurement, so the menu is
      // never seen at the off-screen position it was measured at.
      style={{ left: at?.x ?? menu.x, top: at?.y ?? menu.y, visibility: at ? "visible" : "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          buttons[(index + delta + buttons.length) % buttons.length]?.focus();
        }
      }}
    >
      <MenuItems items={menu.items} onClose={onClose} />
    </div>
  );
}

function MenuItems({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="ctx-separator" />;
        if (it.header) {
          return (
            <div key={i} className="ctx-header">
              {it.header}
            </div>
          );
        }
        if (it.submenu) {
          return (
            <div
              key={i}
              className="ctx-sub-wrap"
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub((s) => (s === i ? null : s))}
            >
              <button className={`ctx-item has-sub${it.disabled ? " disabled" : ""}`} disabled={it.disabled}>
                <span className="ctx-label">{it.label}</span>
                <span className="ctx-caret">›</span>
              </button>
              {openSub === i && <SubMenu items={it.submenu} onClose={onClose} />}
            </div>
          );
        }
        return (
          <button
            role="menuitem"
            key={i}
            className={`ctx-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            <span className="ctx-label">{it.label}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * A nested menu, opening right unless there is no room for it there.
 *
 * The parent menu flips to the left of the pointer near the right edge, which
 * is exactly where a submenu opening rightwards would then leave the window —
 * so the two decisions have to be made independently, each from its own
 * measured width.
 */
function SubMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"right" | "left" | null>(null);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setSide(box.right > window.innerWidth - EDGE_PAD ? "left" : "right");
  }, [items]);

  return (
    <div
      ref={el}
      className={`context-menu ctx-submenu${side === "left" ? " flip" : ""}`}
      style={{ visibility: side ? "visible" : "hidden" }}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>
  );
}
