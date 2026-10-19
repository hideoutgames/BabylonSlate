import { useEffect, useId, useRef, useState } from "react";
import {
  NumberField,
  POPUP_PICKER_ATTRIBUTE,
  popupMenuFrame,
  usePopupOutsideDismiss,
} from "@babylonslate/editor-kit";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";

export interface SnapValues {
  gridSize: number;
  snapTranslate: number;
  snapRotateDeg: number;
  snapScale: number;
}

const FIELDS = [
  { key: "gridSize", label: "Grid Size", testId: "number-prompt-input" },
  { key: "snapTranslate", label: "Grid Snap", testId: "grid-snap-input" },
  { key: "snapRotateDeg", label: "Rotation Snap", testId: "rotation-snap-input", unit: "deg" },
  { key: "snapScale", label: "Scale Snap", testId: "scale-snap-input" },
] as const;

// Height is the clamp budget; the popup itself is as tall as its rows.
const POPUP_SIZE = { width: 220, height: 150 };

const same = (a: SnapValues, b: SnapValues) =>
  FIELDS.every(({ key }) => a[key] === b[key]);

/**
 * Grid Size, Grid Snap, Rotation Snap and Scale Snap as compact menu-style
 * rows. Edits apply together when the rows close (a press outside, Escape
 * or the menu closing) and on Enter; an invalid draft is never saved.
 */
export function GridSettingsFields({
  value,
  onSubmit,
}: {
  value: SnapValues;
  onSubmit: (value: SnapValues) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const finishRefs = useRef<Partial<Record<keyof SnapValues, (() => number | undefined) | null>>>({});

  /** Finishes every draft like Enter; undefined when any draft is invalid. */
  const finished = () => {
    const next = { ...draft };
    for (const { key } of FIELDS) {
      const result = finishRefs.current[key]?.() ?? draft[key];
      if (!Number.isFinite(result) || result < 0.0001) return undefined;
      next[key] = result;
    }
    return next;
  };
  const commitRef = useRef(() => {});
  commitRef.current = () => {
    const next = finished();
    if (next && !same(next, value)) onSubmit(next);
  };
  // Closing the popup or menu unmounts the rows; that is when edits apply.
  useEffect(() => () => commitRef.current(), []);

  return (
    <div
      className="grid grid-cols-[1fr_5.5rem] items-center gap-x-3 gap-y-1"
      // Typing in a field must not drive the surrounding menu's typeahead or arrows.
      onKeyDown={(event) => {
        if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
      }}
    >
      {FIELDS.map((field) => (
        <label key={field.key} className="contents" htmlFor={`${id}-${field.key}`}>
          <span className="whitespace-nowrap text-xs text-foreground">{field.label}</span>
          <NumberField
            id={`${id}-${field.key}`}
            className="h-6 px-1.5 text-xs pointer-coarse:h-9"
            data-testid={field.testId}
            min={0.0001}
            unit={"unit" in field ? field.unit : undefined}
            value={draft[field.key]}
            onChange={(next) => setDraft((current) => ({ ...current, [field.key]: next }))}
            onEnter={() => commitRef.current()}
            finishRef={(finish) => {
              finishRefs.current[field.key] = finish;
            }}
          />
        </label>
      ))}
    </div>
  );
}

/**
 * Grid Settings in a context popup anchored under the control that opened
 * it, like Add Node: no dimming, no buttons, and a press outside closes it.
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
  // The outside-press hook and the Dialog can both report one dismissal.
  const closedRef = useRef(false);
  useEffect(() => {
    if (open) closedRef.current = false;
  }, [open]);
  const dismiss = () => {
    if (closedRef.current) return;
    closedRef.current = true;
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
        bodyClassName="flex flex-col gap-1.5 px-2.5 py-2"
        style={frame}
      >
        <DialogTitle className="text-[11px] font-medium text-muted-foreground">Grid Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Grid Size sets the visible cell spacing. Grid Snap sets the movement
          increment when snapping is on. Both use world units.
        </DialogDescription>
        {open ? <GridSettingsFields value={initialValue} onSubmit={onSubmit} /> : null}
      </DialogContent>
    </Dialog>
  );
}
