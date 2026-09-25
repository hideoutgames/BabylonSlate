import {
  ChevronDownIcon,
  LayoutGridIcon,
  PanelsTopLeftIcon,
  XIcon,
} from "lucide-react";
import {
  CONTENT_BROWSER_ID,
} from "@babylonslate/core";
import { TypeVisualIcon, ShortcutKeys, ariaKeyShortcuts } from "@babylonslate/editor-kit";
import type { IndexedAsset } from "@babylonslate/assets";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { cn } from "@babylonslate/ui/lib/utils";
import type { OpenDocument } from "../services/document-service";
import { documentTypeVisual } from "../lib/document-type-visual";
import { useKeybindChord, useKeybindCommand } from "../context/keybind-context";

/** The same document list serves compact navigation and overflowing desktop tabs. */
export function DocumentSwitcher({
  documents,
  assets = [],
  activeDocumentId,
  onSelect,
  onClose,
  onCloseAll,
  compact = false,
}: {
  documents: OpenDocument[];
  assets?: readonly IndexedAsset[];
  activeDocumentId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll?: () => void;
  compact?: boolean;
}) {
  const active = documents.find((doc) => doc.id === activeDocumentId);
  const closeChord = useKeybindChord("document.close");
  const closeAllChord = useKeybindChord("document.closeAll");
  const browserChord = useKeybindChord("editor.contentBrowser");
  const hasClosableDocuments = documents.some((doc) => doc.id !== CONTENT_BROWSER_ID);
  const stepDocument = (step: number) => {
    const current = documents.findIndex((doc) => doc.id === activeDocumentId);
    const nextIndex = current < 0
      ? (step > 0 ? 0 : documents.length - 1)
      : (current + step + documents.length) % documents.length;
    const next = documents[nextIndex];
    if (next) onSelect(next.id);
  };
  useKeybindCommand("document.close", () => {
    if (active) onClose(active.id);
  }, {
    enabled: Boolean(active && active.id !== CONTENT_BROWSER_ID),
  });
  useKeybindCommand("document.closeAll", () => onCloseAll?.(), {
    enabled: Boolean(onCloseAll) && hasClosableDocuments,
  });
  useKeybindCommand("document.next", () => stepDocument(1), { enabled: documents.length > 1 });
  useKeybindCommand("document.previous", () => stepDocument(-1), { enabled: documents.length > 1 });
  useKeybindCommand("editor.contentBrowser", () => onSelect(CONTENT_BROWSER_ID), {
    enabled: documents.some((doc) => doc.id === CONTENT_BROWSER_ID),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "touch" : "icon-sm"}
            aria-label="Open Documents"
            title="Open Documents"
            data-testid="document-switcher"
            className={cn(
              "document-switcher",
              compact && "document-switcher-compact",
            )}
          />
        }
      >
        <PanelsTopLeftIcon data-icon="inline-start" />
        {compact ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {active?.ref.label ?? "Documents"}
              {active?.dirty ? " *" : ""}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        data-testid="open-documents-menu"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Open Documents</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeDocumentId ?? ""}
            onValueChange={onSelect}
          >
            {documents.map((doc) => (
              <DropdownMenuRadioItem
                key={doc.id}
                value={doc.id}
                className="min-h-11"
                data-document-id={doc.id}
                aria-keyshortcuts={doc.id === CONTENT_BROWSER_ID && browserChord ? ariaKeyShortcuts(browserChord) : undefined}
              >
                {doc.ref.kind === "content-browser" ? (
                  <LayoutGridIcon />
                ) : (
                  <TypeVisualIcon
                    visual={documentTypeVisual(doc.ref, assets)}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{doc.ref.label}</span>
                {doc.id === CONTENT_BROWSER_ID && browserChord ? (
                  <DropdownMenuShortcut className="pl-4 tracking-normal pointer-coarse:hidden">
                    <ShortcutKeys chord={browserChord} decorative />
                  </DropdownMenuShortcut>
                ) : null}
                {doc.dirty ? (
                  <span
                    aria-label="Unsaved Changes"
                    className="text-muted-foreground"
                  >
                    *
                  </span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {active && active.id !== CONTENT_BROWSER_ID ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="min-h-11"
                onClick={() => onClose(active.id)}
                aria-keyshortcuts={closeChord ? ariaKeyShortcuts(closeChord) : undefined}
              >
                <XIcon />
                <span className="truncate">Close {active.ref.label}</span>
                {closeChord ? (
                  <DropdownMenuShortcut className="pl-4 tracking-normal pointer-coarse:hidden">
                    <ShortcutKeys chord={closeChord} decorative />
                  </DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="min-h-11"
            disabled={
              !onCloseAll ||
              !hasClosableDocuments
            }
            onClick={onCloseAll}
            aria-keyshortcuts={closeAllChord ? ariaKeyShortcuts(closeAllChord) : undefined}
          >
            <XIcon />
            <span className="truncate">Close Open Tab(s)</span>
            {closeAllChord ? (
              <DropdownMenuShortcut className="pl-4 tracking-normal pointer-coarse:hidden">
                <ShortcutKeys chord={closeAllChord} decorative />
              </DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
