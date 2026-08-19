import { NestedMenu } from "./nested-menu";
import type { ContextMenuState } from "./use-context-menu";

export interface ContextMenuOverlayProps {
  menu: ContextMenuState | null;
  onClose: () => void;
  contentTestId?: string;
}

export function ContextMenuOverlay({
  menu,
  onClose,
  contentTestId = "context-menu-panel",
}: ContextMenuOverlayProps) {
  if (!menu?.open) return null;

  return (
    <>
      <div
        className="context-menu-backdrop"
        data-testid="context-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <NestedMenu
        items={menu.items}
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        anchor={{ x: menu.x, y: menu.y }}
        size="touch"
        contentTestId={contentTestId}
      />
    </>
  );
}
