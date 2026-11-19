import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { ContextMenuOverlay, useContextMenu } from "@haptic/editor-kit";
import { useGraphEditorContext } from "./graph-editor-context";

/** Set on a pin's cell (or its hit area) while that pin's menu is open; graph-editor.css draws its highlight. */
const PIN_MENU_OPEN_ATTRIBUTE = "data-pin-menu-open";

/**
 * Right-click and long-press menu of a script-style node or a state. The items are built
 * when the menu opens, for the element the gesture began on: a pin's glyph or name opens
 * that pin's menu when it has items, anything else the node's (after the selection rule).
 * While a pin's menu is open its cell carries `data-pin-menu-open`, set and removed here
 * without rendering anything.
 */
export function useNodeMenu(nodeId: string) {
  const { nodeMenu } = useGraphEditorContext();
  const enabled = nodeMenu?.enabled === true;
  const targetRef = useRef<EventTarget | null>(null);
  const openRef = useRef(false);
  const heldPinRef = useRef<Element | null>(null);
  const releasePin = useCallback(() => {
    heldPinRef.current?.removeAttribute(PIN_MENU_OPEN_ATTRIBUTE);
    heldPinRef.current = null;
  }, []);
  const menu = useContextMenu({
    items: () => {
      releasePin();
      const resolved = nodeMenu?.resolve(nodeId, targetRef.current);
      const items = resolved?.items ?? [];
      if (items.length > 0) {
        openRef.current = true;
        if (resolved?.pinCell) {
          resolved.pinCell.setAttribute(PIN_MENU_OPEN_ATTRIBUTE, "");
          heldPinRef.current = resolved.pinCell;
        }
      }
      return items;
    },
    enabled,
  });
  const open = menu.menu !== null;
  useEffect(() => {
    if (open) return;
    openRef.current = false;
    releasePin();
  }, [open, releasePin]);
  useEffect(() => releasePin, [releasePin]);
  const bind = {
    ...menu.bind,
    onPointerDown: (event: PointerEvent) => {
      targetRef.current = event.target;
      menu.bind.onPointerDown(event);
    },
    onContextMenu: (event: MouseEvent) => {
      if (enabled) event.stopPropagation();
      // Android follows a touch hold with `contextmenu`: the hold already opened the menu.
      if (openRef.current) {
        event.preventDefault();
        return;
      }
      targetRef.current = event.target;
      menu.bind.onContextMenu(event);
    },
  };
  return { bind, overlay: <ContextMenuOverlay menu={menu.menu} onClose={menu.closeMenu} /> };
}
