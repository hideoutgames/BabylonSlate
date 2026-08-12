import { AppWindowIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { useDocuments } from "../context/document-context";
import { listEditorUtilityWindows } from "../shell/editor-utility-windows";
import { listDockWindows } from "../shell/window-catalog";

export function WindowsMenu() {
  const {
    projectName,
    openDocuments,
    activeDocumentId,
    toggleDockWindow,
    isDockWindowOpen,
    openDockWindowCount,
  } = useDocuments();

  const activeKind = openDocuments.find((doc) => doc.id === activeDocumentId)
    ?.ref.kind;
  const canToggleWindows = activeKind === "scene" || activeKind === "graph";
  const windows = canToggleWindows ? listDockWindows(activeKind) : [];
  const editorUtilities = listEditorUtilityWindows();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="windows-menu-content">
        {windows.map((entry) => {
          const open = isDockWindowOpen(entry.id);
          return (
            <DropdownMenuCheckboxItem
              key={entry.id}
              data-testid={`windows-menu-${entry.id}`}
              checked={open}
              disabled={open && openDockWindowCount <= 1}
              onCheckedChange={() => toggleDockWindow(entry.id)}
            >
              {entry.title}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="windows-editor-utilities">
            Editor Utilities
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent data-testid="windows-editor-utilities-menu">
            {editorUtilities.length === 0 ? (
              <DropdownMenuItem disabled data-testid="windows-editor-utilities-empty">
                None registered
              </DropdownMenuItem>
            ) : (
              editorUtilities.map((entry) => {
                const open = isDockWindowOpen(entry.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={entry.id}
                    data-testid={`windows-menu-${entry.id}`}
                    checked={open}
                    disabled={open && openDockWindowCount <= 1}
                    onCheckedChange={() => toggleDockWindow(entry.id)}
                  >
                    {entry.title}
                  </DropdownMenuCheckboxItem>
                );
              })
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
