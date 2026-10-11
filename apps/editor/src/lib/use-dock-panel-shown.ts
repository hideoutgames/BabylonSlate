import { useEffect, useState } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { useActiveDocumentId } from "../context/document-context";
import { useOptionalDocumentWorkspace } from "../context/document-workspace-context";

/**
 * Whether a dock panel is on screen. Dockview's `isVisible` covers the active
 * tab of a shown group, including the one window a phone shows; inactive
 * document tabs stay mounted but hidden, so the panel's document must also be
 * the active one. Without a Dockview API the panel counts as visible.
 */
export function useDockPanelShown(api: DockviewPanelApi | undefined): boolean {
  const workspace = useOptionalDocumentWorkspace();
  const activeDocumentId = useActiveDocumentId();
  const [visible, setVisible] = useState(api?.isVisible ?? true);
  useEffect(() => {
    if (!api) return;
    setVisible(api.isVisible);
    const subscription = api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => subscription.dispose();
  }, [api]);
  return visible && (!workspace || workspace.documentId === activeDocumentId);
}
