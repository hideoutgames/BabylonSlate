import { useCallback, useEffect, useRef, useState } from "react";
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
import { cn } from "@haptic/ui/lib/utils";

/** An asset the dialog lists; `plugin` names the plugin it comes from, when the batch spans plugins. */
export type ExecuteJavaScriptReviewAsset = ExecuteJavaScriptAsset & { plugin?: string };

export type ExecuteJavaScriptImportDialogProps = {
  /** The assets of the batch that hold Execute JavaScript; the dialog is open while there are any. */
  assets: readonly ExecuteJavaScriptReviewAsset[] | null;
  /**
   * `import` (default): Import or Cancel, which imports nothing. `newProject`: a New Project's library
   * plugins, Include or Create Without, which creates the project without them.
   */
  purpose?: "import" | "newProject";
  /**
   * `newProject` only: whether the new project starts trusted on this computer (one created from
   * scratch), so the included code runs at Play; a project from a template waits for trust.
   */
  newProjectTrusted?: boolean;
  /** Extra classes for the dialog, such as a theme or a layer above the launcher's loading card. */
  className?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Discloses Execute JavaScript before anything is written: what an import brings in (Content Browser
 * files, ZIPs and drops, or a `.hplugin`), or the Engine Plugins a New Project would copy. One dialog
 * per batch, listing each asset with its node count.
 */
export function ExecuteJavaScriptImportDialog({
  assets, purpose = "import", newProjectTrusted = false, className, onConfirm, onCancel,
}: ExecuteJavaScriptImportDialogProps) {
  const list = assets ?? [];
  const newProject = purpose === "newProject";
  return (
    <AlertDialog open={list.length > 0} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent variant="warning" className={cn("data-[size=default]:sm:max-w-md", className)} data-testid="execute-javascript-import-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <CodeIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{newProject ? "Include Execute JavaScript?" : "Import Execute JavaScript?"}</AlertDialogTitle>
          {newProject ? (
            <AlertDialogDescription>
              Engine Plugins from your library contain Execute JavaScript nodes. Their code runs without a sandbox, with
              the same access as the game, when the project plays or is packaged. Include them only if you trust where
              they came from; otherwise the project is created without them.{" "}
              {newProjectTrusted
                ? "The new project is trusted on this computer, so this code runs when you press Play."
                : "A project made from a template is not trusted, so this code runs only once you trust the project."}
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription>
              {list.length === 1 ? "This asset contains" : "These assets contain"} Execute JavaScript nodes. Their code runs
              without a sandbox, with the same access as the game, when the project plays or is packaged. Import only if
              you trust where {list.length === 1 ? "it" : "they"} came from.
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <ul className="max-h-60 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm"
          data-testid="execute-javascript-import-list">
          {list.map((asset, index) => (
            <li key={`${asset.guid}:${index}`} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate" title={asset.path ?? asset.name}>
                {asset.name} <span className="text-muted-foreground">({asset.type}){asset.plugin ? ` in ${asset.plugin}` : ""}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {asset.nodes.length === 1 ? "1 node" : `${asset.nodes.length} nodes`}
              </span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="execute-javascript-import-cancel">{newProject ? "Create Without" : "Cancel"}</AlertDialogCancel>
          <AlertDialogAction data-testid="execute-javascript-import-confirm" onClick={onConfirm}>
            {newProject ? "Include" : "Import"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The question an import or New Project waits on: `review(assets)` shows the dialog and resolves true for
 * Import or Include, false for Cancel or Create Without. A newer question cancels the one still open, and
 * the host unmounting (its panel closed, the project closed) answers false, so a waiting import always
 * settles and writes nothing.
 */
export function useExecuteJavaScriptReview(): {
  assets: ExecuteJavaScriptReviewAsset[] | null;
  review: (assets: ExecuteJavaScriptReviewAsset[]) => Promise<boolean>;
  answer: (confirmed: boolean) => void;
} {
  const [assets, setAssets] = useState<ExecuteJavaScriptReviewAsset[] | null>(null);
  const answerRef = useRef<((confirmed: boolean) => void) | null>(null);
  const answer = useCallback((confirmed: boolean) => {
    const resolve = answerRef.current;
    answerRef.current = null;
    setAssets(null);
    resolve?.(confirmed);
  }, []);
  const review = useCallback((next: ExecuteJavaScriptReviewAsset[]) => new Promise<boolean>((resolve) => {
    answerRef.current?.(false);
    answerRef.current = resolve;
    setAssets(next);
  }), []);
  useEffect(() => () => {
    const resolve = answerRef.current;
    answerRef.current = null;
    resolve?.(false);
  }, []);
  return { assets, review, answer };
}
