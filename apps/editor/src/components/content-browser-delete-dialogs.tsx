import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  ArrowRightIcon,
  ChevronsUpDownIcon,
  CircleCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { IndexedAsset } from "@haptic/assets";
import {
  SelectableText,
  TypeVisualIcon,
  resolveTypeVisual,
  ClassPicker,
  PickerIdentity,
  type TypeVisual,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Alert, AlertTitle } from "@haptic/ui/components/alert";
import { Badge } from "@haptic/ui/components/badge";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@haptic/ui/components/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
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
import { classIdFromClassAsset, type DeleteTarget } from "../lib/content-browser-helpers";

export interface DeleteListItem {
  key: string;
  name: string;
  detail: string;
  count: string | null;
  visual: TypeVisual;
}

export interface DeleteInboundRef {
  guid: string;
  name: string;
  path: string;
  type: string | undefined;
  targets: string[];
  targetGuids: string[];
  blocksClassDelete: boolean;
}

interface ContentBrowserDeleteDialogsProps {
  deleteTarget: DeleteTarget | null;
  setDeleteTarget: (target: DeleteTarget | null) => void;
  confirmReferencedDelete: boolean;
  setConfirmReferencedDelete: (confirm: boolean) => void;
  replacementPicker: string | null;
  setReplacementPicker: (guid: string | null) => void;
  classReplacementChoices: Record<string, string | null>;
  setClassReplacementChoices: Dispatch<SetStateAction<Record<string, string | null>>>;
  deleteCancelRef: RefObject<HTMLButtonElement | null>;
  deleteInboundRefs: readonly DeleteInboundRef[];
  deleteListItems: readonly DeleteListItem[];
  deleteListNames: readonly string[];
  hasReferencedClass: boolean;
  deleteLastSceneClassLines: readonly string[];
  deletedClasses: readonly IndexedAsset[];
  pickerCandidates: readonly IndexedAsset[];
  classReplacements: ReadonlyArray<{ guid: string; replacement: { guid: string } | null }>;
  resolveAssetName: (guid: string) => string;
  busy: boolean;
  confirmDelete: () => Promise<void>;
  deleteProgress: { done: number; total: number; currentName: string } | null;
  deleteError: string | null;
  setDeleteError: (error: string | null) => void;
}


/** The Content Browser delete confirmation, its Class replacements, progress and failure. */
export function ContentBrowserDeleteDialogs({
  deleteTarget,
  setDeleteTarget,
  confirmReferencedDelete,
  setConfirmReferencedDelete,
  replacementPicker,
  setReplacementPicker,
  classReplacementChoices,
  setClassReplacementChoices,
  deleteCancelRef,
  deleteInboundRefs,
  deleteListItems,
  deleteListNames,
  hasReferencedClass,
  deleteLastSceneClassLines,
  deletedClasses,
  pickerCandidates,
  classReplacements,
  resolveAssetName,
  busy,
  confirmDelete,
  deleteProgress,
  deleteError,
  setDeleteError,
}: ContentBrowserDeleteDialogsProps) {
  return (
    <>
      <AlertDialog
        open={deleteTarget !== null && !confirmReferencedDelete && !replacementPicker}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent
          variant="destructive"
          className="editor-dialog-large editor-dialog-delete flex flex-col gap-0 overflow-hidden p-0"
          initialFocus={deleteCancelRef}
          data-testid="content-browser-delete-dialog"
          data-has-references={deleteInboundRefs.length > 0}
        >
          <AlertDialogHeader className="flex shrink-0 items-start gap-3 px-4 pt-4 pb-1">
            <AlertDialogMedia className="mb-0 size-8 shrink-0" data-testid="content-browser-delete-media">
              <Trash2Icon className="size-4" />
            </AlertDialogMedia>
            <div className="flex min-w-0 flex-col gap-1">
              <AlertDialogTitle className="break-words">
                {deleteListItems.length === 1
                  ? `Delete ${deleteListItems[0]!.name}?`
                  : deleteTarget?.kind === "selection" && deleteTarget.folders.length > 0
                    ? `Delete ${deleteListNames.length} Items`
                    : `Delete ${deleteListNames.length} Assets`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {hasReferencedClass ? "Choose a replacement for each referenced Class, or leave None to clear its usages. This cannot be undone."
                  : deleteInboundRefs.length > 0
                  ? `${deleteInboundRefs.length === 1 ? "1 asset or setting" : `${deleteInboundRefs.length} assets or settings`} will lose references. This cannot be undone.`
                  : "This cannot be undone."}
              </AlertDialogDescription>
            </div>
          </AlertDialogHeader>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-y-contain px-4 py-3 touch-pan-y"
            tabIndex={0} role="region" aria-label="Assets And References"
            data-testid="content-browser-delete-body">
            {deleteLastSceneClassLines.length > 0 && (
              <Alert variant="destructive" className="bg-destructive/5">
                <TriangleAlertIcon />
                {deleteLastSceneClassLines.map((line) => (
                  <AlertTitle key={line} data-testid="content-browser-delete-last-warning">{line}</AlertTitle>
                ))}
              </Alert>
            )}
            <section className="flex min-w-0 flex-col gap-1.5" aria-label="Selected For Deletion">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Deleting <Badge variant="secondary" className="tabular-nums">{deleteListNames.length}</Badge>
              </h3>
              <ul className="flex flex-col divide-y rounded-md border" data-testid="content-browser-delete-list">
                {deleteListItems.map((item) => (
                  <li key={item.key} className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-2 px-2.5 py-1.5 text-sm">
                    <TypeVisualIcon visual={item.visual} />
                    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                      <SelectableText className="font-medium break-words">{item.name}</SelectableText>
                      <SelectableText className="text-xs text-muted-foreground break-all">{item.detail}</SelectableText>
                    </div>
                    {item.count ? <Badge variant="outline" className="tabular-nums">{item.count}</Badge> : null}
                  </li>
                ))}
              </ul>
              {deleteInboundRefs.length === 0 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CircleCheckIcon className="size-3.5 shrink-0" />
                  Nothing else references {deleteListItems.length === 1 ? "this item" : "these items"}.
                </p>
              )}
            </section>
            {hasReferencedClass && (
              <section className="flex min-w-0 flex-col gap-1.5" aria-label="Replace Class">
                <h3 className="text-xs font-medium text-muted-foreground">Replace Class</h3>
                <ul className="flex flex-col divide-y rounded-md border">
                  {deletedClasses.filter((asset) => deleteInboundRefs.some((ref) => ref.targetGuids.includes(asset.header.guid))).map((asset) => {
                    const usages = deleteInboundRefs.filter((ref) => ref.targetGuids.includes(asset.header.guid)).length;
                    return (
                      <li key={asset.header.guid}>
                        <Field orientation="horizontal" className="flex-wrap items-center gap-2 px-2.5 py-1.5">
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <TypeVisualIcon visual={resolveTypeVisual({ family: "class" })} />
                            <FieldLabel htmlFor={`replace-class-${asset.header.guid}`} className="min-w-0 truncate">
                              <span className="sr-only">Replace </span>{resolveAssetName(asset.header.guid)}
                            </FieldLabel>
                            <Badge variant="secondary" className="tabular-nums">{usages === 1 ? "1 Usage" : `${usages} Usages`}</Badge>
                            <ArrowRightIcon className="ml-auto hidden size-3.5 shrink-0 text-muted-foreground sm:block" />
                          </div>
                          <Button id={`replace-class-${asset.header.guid}`} variant="outline" size="sm"
                            className="min-h-[var(--touch-target,28px)] w-full shrink-0 justify-between sm:w-48"
                            onClick={() => setReplacementPicker(asset.header.guid)}>
                            {classReplacementChoices[asset.header.guid]
                              ? <PickerIdentity label={resolveAssetName(classReplacementChoices[asset.header.guid]!)} visual={{ family: "class" }} />
                              : <span className="text-muted-foreground">None</span>}
                            <ChevronsUpDownIcon data-icon="inline-end" className="text-muted-foreground" />
                          </Button>
                        </Field>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {deleteInboundRefs.length > 0 && (
              <section className="flex min-w-0 flex-col gap-1.5" aria-label="Referenced By">
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  Referenced By <Badge variant="secondary" className="tabular-nums">{deleteInboundRefs.length}</Badge>
                </h3>
                <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-muted/20">
                  {deleteInboundRefs.map((ref) => (
                    <li key={ref.guid} className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-2 px-2.5 py-1.5 text-sm">
                      <TypeVisualIcon visual={resolveTypeVisual({ assetType: ref.type })} />
                      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                        <SelectableText className="font-medium break-words">{ref.name}</SelectableText>
                        <SelectableText className="text-xs text-muted-foreground break-all">{ref.path}</SelectableText>
                      </div>
                      {deleteListItems.length > 1 || ref.targets.length > 1 ? (
                        <span className="max-w-[40%] shrink-0 text-right text-xs break-words">
                          <span className="text-muted-foreground">Uses </span>{ref.targets.join(", ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <AlertDialogFooter className="m-0 shrink-0 pt-3">
            <AlertDialogCancel
              ref={deleteCancelRef}
              disabled={busy}
              className="pointer-coarse:h-[var(--touch-target,44px)]"
              data-testid="content-browser-delete-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="pointer-coarse:h-[var(--touch-target,44px)]"
              disabled={busy}
              data-testid="content-browser-delete-confirm"
              onClick={(event) => {
                event.preventDefault();
                // The second step shows the Class replacements; other assets
                // have nothing more to choose, so this Delete updates references.
                if (hasReferencedClass) setConfirmReferencedDelete(true);
                else void confirmDelete();
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ClassPicker open={replacementPicker !== null} onOpenChange={(open) => { if (!open) setReplacementPicker(null); }}
        title="Replacement Class" classes={pickerCandidates.map((asset) => ({ id: asset.header.guid,
          name: classIdFromClassAsset(asset), description: asset.path }))}
        onPick={(guid) => {
          if (replacementPicker) setClassReplacementChoices((current) => ({ ...current, [replacementPicker]: guid }));
          setReplacementPicker(null);
        }} />
      <AlertDialog open={confirmReferencedDelete && deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setConfirmReferencedDelete(false); }}>
        <AlertDialogContent variant="destructive" className="data-[size=default]:sm:max-w-md"
          data-testid="content-browser-delete-references-confirmation">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete Referenced Assets?</AlertDialogTitle>
            <AlertDialogDescription>
              Updates references in {deleteInboundRefs.length === 1 ? "1 asset or setting" : `${deleteInboundRefs.length} assets or settings`}. This cannot be undone.
              With None, placed actors keep their data on a base Class and child Classes fall back to Object.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm">
            {classReplacements.map((entry) => <li key={entry.guid} className="px-3 py-1.5">{resolveAssetName(entry.guid)} → {entry.replacement ? resolveAssetName(entry.replacement.guid) : "None"}</li>)}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy}
              data-testid="content-browser-delete-references-confirm" onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>
              Delete And Update References
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={deleteProgress !== null}>
        <DialogContent showCloseButton={false} data-testid="deleting-overlay">
          <DialogHeader>
            <DialogTitle>Deleting Assets</DialogTitle>
            <DialogDescription>Removing files and updating their references.</DialogDescription>
          </DialogHeader>
          {deleteProgress ? (
            <Progress value={Math.round(100 * deleteProgress.done / deleteProgress.total)}>
              <ProgressLabel>{deleteProgress.currentName}</ProgressLabel>
              <ProgressValue />
            </Progress>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteError !== null} onOpenChange={(open) => { if (!open) setDeleteError(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Failed</AlertDialogTitle>
            <AlertDialogDescription>{deleteError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setDeleteError(null)}>Close</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
