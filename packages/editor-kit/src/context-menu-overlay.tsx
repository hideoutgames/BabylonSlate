import type { ContextMenuState } from "./use-context-menu";

export interface ContextMenuOverlayProps {
  menu: ContextMenuState | null;
  onClose: () => void;
}

export function ContextMenuOverlay({ menu, onClose }: ContextMenuOverlayProps) {
  if (!menu?.open) return null;

  return (
    <>
      <div
        className="context-menu-backdrop"
        data-testid="context-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        className="context-menu-panel"
        data-testid="context-menu-panel"
        style={{ left: menu.x, top: menu.y }}
        role="menu"
      >
        {menu.items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="context-menu-item"
            data-testid={`context-menu-item-${item.id}`}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
