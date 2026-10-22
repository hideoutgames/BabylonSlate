import { useEffect } from "react";
import { createPortal } from "react-dom";
import { NestedMenu } from "./nested-menu";
import { useTouchUi } from "./touch-ui";
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
  const touch = useTouchUi();
  useEffect(() => {
    if (!menu?.open) return;
    let awaitingFreshPress = true;
    const onPointerDown = (event: PointerEvent) => {
      awaitingFreshPress = false;
      const target = event.target;
      if (target instanceof Element && !target.closest('[role="menu"]')) {
        onClose();
      }
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
  }, [menu?.open, onClose]);

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
        size={touch ? "touch" : "chrome"}
        contentTestId={contentTestId}
      />
    </>,
    document.body,
  );
}
