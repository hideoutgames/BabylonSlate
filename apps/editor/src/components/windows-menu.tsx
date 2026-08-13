import { useEffect, useMemo, useState } from "react";
import { AppWindowIcon, ChevronDownIcon } from "lucide-react";
import { NestedMenu, type NestedMenuItem } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  useDocuments,
  useDockWindowTick,
} from "../context/document-context";
import { listEditorUtilityWindows } from "../shell/editor-utility-windows";
import { listDockWindows } from "../shell/window-catalog";
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
  } = useDocuments();
  useDockWindowTick();
  const [menuOpen, setMenuOpen] = useState(false);

  const activeKind = openDocuments.find((doc) => doc.id === activeDocumentId)
    ?.ref.kind;
  const canToggleWindows = activeKind === "scene" || activeKind === "graph";
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
    const windows = canToggleWindows
      ? listDockWindows(activeKind, { actorPrefab })
      : [];
    const editorUtilities = listEditorUtilityWindows();
    const checkbox = (entry: { id: string; title: string }): NestedMenuItem => {
      const open = isDockWindowOpen(entry.id);
      return {
        id: entry.id,
        type: "checkbox",
        label: entry.title,
        checked: open,
        closeOnClick: false,
        disabled: open && openDockWindowCount === 1,
        testId: `windows-menu-${entry.id}`,
        onCheckedChange: () => toggleDockWindow(entry.id),
      };
    };

    return [
      ...windows.map(checkbox),
      { type: "separator", id: "utilities-sep" },
      {
        type: "submenu",
        id: "editor-utilities",
        label: "Editor Utilities",
        testId: "windows-editor-utilities",
        contentTestId: "windows-editor-utilities-menu",
        items:
          editorUtilities.length === 0
            ? [
                {
                  id: "empty",
                  label: "None registered",
                  disabled: true,
                  testId: "windows-editor-utilities-empty",
                  onSelect: () => {},
                },
              ]
            : editorUtilities.map(checkbox),
      },
    ];
  }, [
    activeKind,
    actorPrefab,
    canToggleWindows,
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
