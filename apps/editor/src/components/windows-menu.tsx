import { useEffect, useMemo, useState } from "react";
import { AppWindowIcon, ChevronDownIcon } from "lucide-react";
import { NestedMenu, type NestedMenuItem } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  useDocuments,
  useDockWindowTick,
} from "../context/document-context";
import {
  editorUtilityAssetsFromIndexed,
  editorUtilityEmptyLabel,
  editorUtilityGuidFromWindowId,
  listEditorUtilityMenuWindows,
} from "../shell/editor-utility-windows";
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
    openLiveEditorUtility,
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
  const editorUtilityInterface =
    indexed?.header.type === "EditorUtilityInterface";
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
          editorUtilityInterface,
          sourceControl: sourceControl.enabled,
          uiEditorMode: activeKind === "ui" ? uiEditorMode : undefined,
          animEditorMode:
            activeKind === "anim-graph" ? animEditorMode : undefined,
        })
      : [];
    const utilityAssets = editorUtilityAssetsFromIndexed(
      assetRegistry?.list() ?? [],
      openDocuments,
    );
    const editorUtilities = listEditorUtilityMenuWindows({
      kind: activeKind,
      assets: utilityAssets,
    });
    const emptyLabel = editorUtilityEmptyLabel(activeKind, utilityAssets);
    const openLiveHost = activeKind === "ui";
    const checkbox = (
      entry: { id: string; title: string },
      options?: { liveHost?: boolean },
    ): NestedMenuItem => {
      const open = isDockWindowOpen(entry.id);
      const guid = editorUtilityGuidFromWindowId(entry.id);
      return {
        id: entry.id,
        type: "checkbox",
        label: entry.title,
        checked: open,
        closeOnClick: false,
        disabled: !options?.liveHost && open && openDockWindowCount === 1,
        testId: `windows-menu-${entry.id}`,
        onCheckedChange: () => {
          if (options?.liveHost && guid) {
            void openLiveEditorUtility(guid);
            return;
          }
          toggleDockWindow(entry.id);
        },
      };
    };

    return [
      ...windows.map((entry) => checkbox(entry)),
      { type: "separator", id: "utilities-sep" },
      {
        type: "submenu",
        id: "editor-utilities",
        label: "Editor Utilities",
        testId: "windows-editor-utilities",
        contentTestId: "windows-editor-utilities-menu",
        items:
          emptyLabel
            ? [
                {
                  id: "empty",
                  label: emptyLabel,
                  disabled: true,
                  testId: "windows-editor-utilities-empty",
                  onSelect: () => {},
                },
              ]
            : editorUtilities.map((entry) =>
                checkbox(entry, { liveHost: openLiveHost }),
              ),
      },
    ];
  }, [
    activeKind,
    actorPrefab,
    editorUtilityInterface,
    uiEditorMode,
    animEditorMode,
    assetRegistry,
    openDocuments,
    sourceControl.enabled,
    isDockWindowOpen,
    openDockWindowCount,
    openLiveEditorUtility,
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
