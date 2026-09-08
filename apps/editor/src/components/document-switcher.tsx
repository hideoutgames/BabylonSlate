import {
  ChevronDownIcon,
  LayoutGridIcon,
  PanelsTopLeftIcon,
  XIcon,
} from "lucide-react";
import {
  CONTENT_BROWSER_ID,
  assetTypeForDocumentKind,
} from "@babylonslate/core";
import { TypeVisualIcon, resolveTypeVisual } from "@babylonslate/editor-kit";
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
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { cn } from "@babylonslate/ui/lib/utils";
import type { OpenDocument } from "../services/document-service";

/** The same document list serves compact navigation and overflowing desktop tabs. */
export function DocumentSwitcher({
  documents,
  activeDocumentId,
  onSelect,
  onClose,
  compact = false,
}: {
  documents: OpenDocument[];
  activeDocumentId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  compact?: boolean;
}) {
  const active = documents.find((doc) => doc.id === activeDocumentId);
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
              >
                {doc.ref.kind === "content-browser" ? (
                  <LayoutGridIcon />
                ) : (
                  <TypeVisualIcon
                    visual={resolveTypeVisual({
                      assetType: assetTypeForDocumentKind(doc.ref.kind),
                    })}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{doc.ref.label}</span>
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
              >
                <XIcon />
                <span className="truncate">Close {active.ref.label}</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
