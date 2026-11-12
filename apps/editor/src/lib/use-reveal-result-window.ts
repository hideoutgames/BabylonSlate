import { useCallback } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useDocumentActions } from "../context/document-context";
import { revealResultWindow } from "./reveal-result-window";

/**
 * For a Compiler Results panel: brings the document's `panelId` window forward
 * when a row is chosen (`open` false) or opened (`open` true), by the rules of
 * `revealResultWindow`.
 */
export function useRevealResultWindow(
  props: Partial<Pick<IDockviewPanelProps, "api" | "containerApi">> | undefined,
  panelId: string | undefined,
): (open: boolean) => void {
  const { toggleDockWindow } = useDocumentActions();
  const api = props?.api;
  const dock = props?.containerApi;
  return useCallback(
    (open: boolean) => {
      if (!panelId) return;
      revealResultWindow({
        dock,
        // Read when the row is chosen: the panel can move to another group.
        resultsGroupId: api?.group?.id,
        panelId,
        open,
        reopen: toggleDockWindow,
      });
    },
    [api, dock, panelId, toggleDockWindow],
  );
}
