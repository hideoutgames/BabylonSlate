import { useEffect, useMemo, useState } from "react";
import { AppWindowIcon, ChevronDownIcon } from "lucide-react";
import { NestedMenu, type NestedMenuItem } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  useActiveDocumentState,
  useDockWindowTick,
  useDocumentActions,
  useOpenDocumentTabs,
  useProjectState,
  useRegistryState,
  useSourceControl,
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
  const { toggleDockWindow, isDockWindowOpen, getOpenDockWindowCount } =
    useDocumentActions();
  const { projectName } = useProjectState();
  const openDocuments = useOpenDocumentTabs();
  const { activeDocumentId, animEditorMode, sceneMode } = useActiveDocumentState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { sourceControl } = useSourceControl();
  // Dock windows opening or closing: `isDockWindowOpen` and the count change.
  useDockWindowTick();
  const [menuOpen, setMenuOpen] = useState(false);

  const activeDoc = openDocuments.find((doc) => doc.id === activeDocumentId);
  const activeKind = activeDoc?.ref.kind;
  const activePath = activeDoc?.ref.path;
  const canToggleWindows = isDockviewDocumentKind(activeKind);
  // Class ancestry only changes with the registry, not with document edits.
  const actorPrefab = useMemo(() => {
    void registryEpoch;
    if (activeKind !== "graph" || !activePath) return true;
    const indexed = assetRegistry?.list().find((asset) => asset.path === activePath);
    if (!indexed) return true;
    return classDocumentShowsPrefab(
      indexed.header.parentClass,
      classParentLookup(assetRegistry?.list() ?? []),
      { assetType: indexed.header.type },
    );
  }, [activeKind, activePath, assetRegistry, registryEpoch]);
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
          animEditorMode:
            activeKind === "anim-graph" ? animEditorMode : undefined,
          sceneMode: activeKind === "scene" ? sceneMode : undefined,
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
    animEditorMode,
    sceneMode,
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
