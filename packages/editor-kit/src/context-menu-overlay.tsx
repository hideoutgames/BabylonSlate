import { useEffect } from "react";
import { createPortal } from "react-dom";
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
  useEffect(() => {
    if (!menu?.open) return;
    let awaitingFreshPress = true;
    const onPointerDown = () => {
      awaitingFreshPress = false;
    };
    const onClick = (event: MouseEvent) => {
      if (!awaitingFreshPress || event.detail === 0) return;
      // A held pointer can release over the newly mounted backdrop or menu.
      // Its synthesized click belongs to the opener, not the new surface.
      awaitingFreshPress = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [menu?.open]);

  if (!menu?.open) return null;

  return createPortal(
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
    </>,
    document.body,
  );
}
