import type { ExecuteJavaScriptAsset } from "@haptic/core";
import { CodeIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";

export type ExecuteJavaScriptImportDialogProps = {
  /** The assets of the import that hold Execute JavaScript; the dialog is open while there are any. */
  assets: readonly ExecuteJavaScriptAsset[] | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Discloses the Execute JavaScript an import brings in (Content Browser files, ZIPs and drops, or a
 * `.hplugin`) before anything is written: one dialog per batch, listing each asset with its node
 * count. Cancel imports nothing.
 */
export function ExecuteJavaScriptImportDialog({ assets, onConfirm, onCancel }: ExecuteJavaScriptImportDialogProps) {
  const list = assets ?? [];
  return (
    <AlertDialog open={list.length > 0} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent variant="warning" className="data-[size=default]:sm:max-w-md" data-testid="execute-javascript-import-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <CodeIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>Import Execute JavaScript?</AlertDialogTitle>
          <AlertDialogDescription>
            {list.length === 1 ? "This asset contains" : "These assets contain"} Execute JavaScript nodes. Their code runs
            without a sandbox, with the same access as the game, when the project plays or is packaged. Import only if
            you trust where {list.length === 1 ? "it" : "they"} came from.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-60 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm"
          data-testid="execute-javascript-import-list">
          {list.map((asset, index) => (
            <li key={`${asset.guid}:${index}`} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate" title={asset.path ?? asset.name}>
                {asset.name} <span className="text-muted-foreground">({asset.type})</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {asset.nodes.length === 1 ? "1 node" : `${asset.nodes.length} nodes`}
              </span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="execute-javascript-import-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="execute-javascript-import-confirm" onClick={onConfirm}>
            Import
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
