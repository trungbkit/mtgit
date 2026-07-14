import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
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
