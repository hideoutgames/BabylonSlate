import type { MouseEvent } from "react";
import { ContextMenuOverlay, useContextMenu } from "@haptic/editor-kit";
import { useGraphEditorContext } from "./graph-editor-context";

/**
 * Right-click and long-press menu of a script-style node or a state. The items are built
 * when the menu opens, after the selection rule has run for this node.
 */
export function useNodeMenu(nodeId: string) {
  const { nodeMenu } = useGraphEditorContext();
  const enabled = nodeMenu?.enabled === true;
  const menu = useContextMenu({
    items: () => nodeMenu?.resolve(nodeId) ?? [],
    enabled,
  });
  const bind = {
    ...menu.bind,
    onContextMenu: (event: MouseEvent) => {
      if (enabled) event.stopPropagation();
      menu.bind.onContextMenu(event);
    },
  };
  return { bind, overlay: <ContextMenuOverlay menu={menu.menu} onClose={menu.closeMenu} /> };
}
