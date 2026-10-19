import { useEffect, useId, useRef, useState } from "react";
import {
  NumberField,
  POPUP_PICKER_ATTRIBUTE,
  popupMenuFrame,
  usePopupOutsideDismiss,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";

interface SnapValues {
  gridSize: number;
  snapTranslate: number;
  snapRotateDeg: number;
  snapScale: number;
}

const FIELDS = [
  { key: "gridSize", label: "Grid Size", testId: "number-prompt-input" },
  { key: "snapTranslate", label: "Grid Snap", testId: "grid-snap-input" },
  { key: "snapRotateDeg", label: "Rotation Snap (Degrees)", testId: "rotation-snap-input" },
  { key: "snapScale", label: "Scale Snap", testId: "scale-snap-input" },
] as const;

// Height is the clamp budget; the popup itself is as tall as its fields.
const POPUP_SIZE = { width: 340, height: 190 };

const same = (a: SnapValues, b: SnapValues) =>
  FIELDS.every(({ key }) => a[key] === b[key]);

/**
 * Grid and snap steps in a context popup anchored under the control that
 * opened it, like Add Node: no dimming, and a press outside closes it. Done,
 * Enter and closing keep the finished values; an invalid draft is never saved.
 */
export function GridSizeDialog({
  open,
  onOpenChange,
  anchor,
  initialValue,
  onSubmit,
  "data-testid": testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Top-left of the popup, usually just below the opening control. */
  anchor?: { x: number; y: number } | null;
  initialValue: SnapValues;
  onSubmit: (value: SnapValues) => void;
  "data-testid"?: string;
}) {
  const id = useId();
  const { gridSize, snapTranslate, snapRotateDeg, snapScale } = initialValue;
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue({ gridSize, snapTranslate, snapRotateDeg, snapScale });
  }, [open, gridSize, snapTranslate, snapRotateDeg, snapScale]);
  // The outside-press hook and the Dialog can both report one dismissal.
  const closedRef = useRef(false);
  useEffect(() => {
    if (open) closedRef.current = false;
  }, [open]);

  const finishRefs = useRef<
    Partial<Record<keyof SnapValues, (() => number | undefined) | null>>
  >({});

  /** Finishes every draft like Enter; undefined when any draft is invalid. */
  const finished = (entered?: { key: keyof SnapValues; value: number }) => {
    const next = { ...value };
    for (const { key } of FIELDS) {
      const result = entered?.key === key ? entered.value : finishRefs.current[key]?.();
      if (result === undefined || !Number.isFinite(result) || result < 0.0001) return undefined;
      next[key] = result;
    }
    return next;
  };

  const commit = (next: SnapValues | undefined) => {
    if (next && !same(next, initialValue)) onSubmit(next);
  };

  // Done and Enter stay open over an invalid draft so its explanation shows.
  const finishAndClose = (entered?: { key: keyof SnapValues; value: number }) => {
    const next = finished(entered);
    if (!next || closedRef.current) return;
    closedRef.current = true;
    commit(next);
    onOpenChange(false);
  };

  // A press outside or Escape keeps valid values, like leaving any context menu.
  const dismiss = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    commit(finished());
    onOpenChange(false);
  };
  usePopupOutsideDismiss(open, dismiss);

  const placed = open ? popupMenuFrame(anchor, POPUP_SIZE) : undefined;
  const frame = placed ? { left: placed.left, top: placed.top, width: placed.width } : undefined;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : dismiss())}>
      <DialogContent
        data-testid={testId}
        {...{ [POPUP_PICKER_ATTRIBUTE]: "" }}
        showCloseButton={false}
        overlayClassName="catalog-menu-overlay bg-transparent"
        className="catalog-menu-popup max-w-none translate-x-0 translate-y-0 rounded-lg sm:max-w-none"
        bodyClassName="flex flex-col gap-2 p-2"
        style={frame}
      >
        <DialogTitle className="px-1 text-sm">Grid Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Grid Size sets the visible cell spacing. Grid Snap sets the movement
          increment when snapping is on. Both use world units.
        </DialogDescription>
        {open ? (
          <div className="grid grid-cols-2 gap-x-2 gap-y-2">
            {FIELDS.map(({ key, label, testId: inputTestId }) => (
              <Field key={key} className="gap-1">
                <FieldLabel htmlFor={`${id}-${key}`} className="whitespace-nowrap text-xs text-muted-foreground">
                  {label}
                </FieldLabel>
                <NumberField
                  id={`${id}-${key}`}
                  className="h-7 text-xs"
                  data-testid={inputTestId}
                  min={0.0001}
                  value={value[key]}
                  onChange={(next) =>
                    setValue((current) => ({ ...current, [key]: next }))
                  }
                  onEnter={(next) => finishAndClose({ key, value: next })}
                  finishRef={(finish) => {
                    finishRefs.current[key] = finish;
                  }}
                />
              </Field>
            ))}
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button size="xs" data-testid="number-prompt-confirm" onClick={() => finishAndClose()}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
