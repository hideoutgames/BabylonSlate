import { useEffect, useMemo, useState } from "react";
import { AppWindowIcon, ChevronDownIcon } from "lucide-react";
import { NestedMenu, type NestedMenuItem } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  useDocuments,
  useDockWindowTick,
} from "../context/document-context";
import {
  isDockviewDocumentKind,
  listDockWindows,
} from "../shell/window-catalog";
import {
  classDocumentShowsPrefab,
  classParentLookup,
} from "../lib/content-browser-helpers";

export function WindowsMenu() {
  const {
    projectName,
    openDocuments,
    activeDocumentId,
    toggleDockWindow,
    isDockWindowOpen,
    getOpenDockWindowCount,
    assetRegistry,
    sourceControl,
    uiEditorMode,
    animEditorMode,
  } = useDocuments();
  useDockWindowTick();
  const [menuOpen, setMenuOpen] = useState(false);

  const activeKind = openDocuments.find((doc) => doc.id === activeDocumentId)
    ?.ref.kind;
  const canToggleWindows = isDockviewDocumentKind(activeKind);
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const activeDoc = openDocuments.find((doc) => doc.id === activeDocumentId);
  const indexed = assetRegistry
    ?.list()
    .find((asset) => asset.path === activeDoc?.ref.path);
  const actorPrefab =
    activeKind !== "graph" ||
    !indexed ||
    classDocumentShowsPrefab(indexed.header.parentClass, parentOf, {
      assetType: indexed.header.type,
    });
  const openDockWindowCount = getOpenDockWindowCount();

  useEffect(() => {
    if (!projectName || !canToggleWindows) {
      setMenuOpen(false);
    }
  }, [canToggleWindows, projectName]);

  const items = useMemo((): NestedMenuItem[] => {
    const windows = isDockviewDocumentKind(activeKind)
      ? listDockWindows(activeKind, {
          actorPrefab,
          sourceControl: sourceControl.enabled,
          uiEditorMode: activeKind === "ui" ? uiEditorMode : undefined,
          animEditorMode:
            activeKind === "anim-graph" ? animEditorMode : undefined,
        })
      : [];
    return windows.map((entry) => {
      const open = isDockWindowOpen(entry.id);
      return {
        id: entry.id,
        type: "checkbox",
        label: entry.title,
        checked: open,
        closeOnClick: false,
        disabled: open && openDockWindowCount === 1,
        testId: `windows-menu-${entry.id}`,
        onCheckedChange: () => {
          toggleDockWindow(entry.id);
        },
      };
    });
  }, [
    activeKind,
    actorPrefab,
    uiEditorMode,
    animEditorMode,
    sourceControl.enabled,
    isDockWindowOpen,
    openDockWindowCount,
    toggleDockWindow,
  ]);

  return (
    <NestedMenu
      items={items}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      align="end"
      contentTestId="windows-menu-content"
      contentClassName="min-w-44 duration-0 data-open:animate-none data-closed:animate-none"
      trigger={
        <Button
          size="sm"
          variant="outline"
          data-testid="windows-menu"
          className="chrome-action-button"
          aria-label="Windows"
          disabled={!projectName || !canToggleWindows}
        />
      }
    >
      <AppWindowIcon data-icon="inline-start" />
      Windows
      <ChevronDownIcon data-icon="inline-end" />
    </NestedMenu>
  );
}
