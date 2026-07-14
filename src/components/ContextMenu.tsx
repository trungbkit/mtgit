import { useEffect } from "react";
import "./contextmenu.css";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
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
      {menu.items.map((it, i) => (
        <button
          key={i}
          className={`ctx-item${it.danger ? " danger" : ""}`}
          disabled={it.disabled}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
