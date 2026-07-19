import { useEffect, useRef, useState } from "react";
import "./contextmenu.css";

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Render a divider instead of a clickable row. */
  separator?: boolean;
  /** Nested items, shown on hover. */
  submenu?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("blur", close);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      ref={root}
      className="context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
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
        if (it.submenu) {
          return (
            <div
              key={i}
              className="ctx-sub-wrap"
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub((s) => (s === i ? null : s))}
            >
              <button className={`ctx-item has-sub${it.disabled ? " disabled" : ""}`} disabled={it.disabled}>
                <span>{it.label}</span>
                <span className="ctx-caret">›</span>
              </button>
              {openSub === i && (
                <div className="context-menu ctx-submenu">
                  <MenuItems items={it.submenu} onClose={onClose} />
                </div>
              )}
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
            {it.label}
          </button>
        );
      })}
    </>
  );
}
