import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ClipboardPasteIcon, CopyIcon, Link2Icon, Link2OffIcon } from "lucide-react";
import { useEditorReadOnly } from "./editor-read-only";
import type { Tag, TagContainer } from "@haptic/core";
import { TagPicker } from "./tag-picker";
import { Button } from "@haptic/ui/components/button";
import { Checkbox } from "@haptic/ui/components/checkbox";
import { Toggle } from "@haptic/ui/components/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@haptic/ui/components/tooltip";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { SelectAllInput } from "./select-all-input";
import { SelectableText } from "./selectable-text";
import { Textarea } from "@haptic/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { Slider } from "@haptic/ui/components/slider";
import { cn } from "@haptic/ui/lib/utils";
import { NumericDragField } from "./numeric-drag-field";
import { isInlineNumberUnit } from "./number-units";
import { humanizePropertyLabel } from "./humanize-property-label";
import { ColorField, type ColorValue } from "./color-field";
import { FlagsField } from "./flags-field";
import { CollisionResponsesField, type CollisionResponsesValue } from "./collision-responses-field";
import { PickerIdentity } from "./picker-identity";
import { type TypeVisualQuery } from "./type-visuals";
import { AssetPickerControl } from "./asset-picker-control";
import { CurveField, type CurveKey } from "./curve-field";
import { RangeField } from "./range-field";
import { CurveValueField } from "./curve-value-field";
import type { CurveEditorKind, CurveEditorValue } from "./curve-editor-model";
import type { RangeFieldKind, RangeFieldValue } from "./range-values";
import { GradientField, type GradientStop } from "./gradient-field";
import { editVectorAxis } from "./linked-axes";
import { ContextMenuOverlay } from "./context-menu-overlay";
import { claimContextMenuEvent, useContextMenu, type ContextMenuItem } from "./use-context-menu";
import { canCopyPropertyRow, canPastePropertyRow, copyPropertyRow, pastePropertyRow } from "./property-clipboard";
import { LabelHint } from "./label-hint";
import { MIXED_VALUES_LABEL } from "./numeric-expression";
import "./styles/property-grid.css";

export type Vector3Value =
  [number, number, number] | [number, number, number, number];

export type RangeValue = [number, number];
export type Color4Value = [number, number, number, number];

interface PropertyRowBase {
  id: string;
  label: string;
  disabled?: boolean;
  /** Selection values differ; reset remains available even if the primary is at default. */
  mixed?: boolean;
  /**
   * An explanation the label shows as a tooltip (`LabelHint`), never as visible text. Only for
   * what the label and control cannot say; most rows need none.
   */
  description?: string;
  /**
   * Visible text under the control for live state the user must see without asking: a missing
   * requirement, why the control is disabled or what it currently resolves to. Never an explanation.
   */
  status?: string;
  /** A visible error under the control, such as a rejected name. */
  error?: string;
  /** Overrides the Field `data-testid` (`property-row-${id}` by default). */
  testId?: string;
  /**
   * The value's unit, e.g. "s", "ms", "px", "%", "deg". Number, vector and
   * slider fields show a short unit after the value (`45°`); longer phrases
   * and other rows show it after the label. Never humanized.
   */
  unit?: string;
  /**
   * Compact control on the label line before Reset (e.g. ValueModeField).
   * Vertical orientation only; no horizontal caller passes one.
   */
  labelAccessory?: ReactNode;
}

export type PropertyRow =
  | (PropertyRowBase & {
      kind: "tag";
      value: Tag;
      defaultValue?: Tag;
      onChange: (value: Tag) => void;
    })
  | (PropertyRowBase & {
      kind: "tag-container";
      value: TagContainer;
      defaultValue?: TagContainer;
      onChange: (value: TagContainer) => void;
    })
  | (PropertyRowBase & {
      kind: "number";
      value: number;
      defaultValue?: number;
      min?: number;
      max?: number;
      validate?: (value: number) => string | undefined;
      sensitivity?: number;
      precision?: number;
      onChange: (value: number) => void;
      onCommit?: (value: number) => void;
      /**
       * A multi-selection's own values, `value`'s first. While `mixed`, typing
       * and scrubbing change each from its own value (`Mixed Values+4`) and
       * report them here instead of `onChange` / `onCommit`.
       */
      itemValues?: number[];
      onItemValuesChange?: (values: number[]) => void;
      onItemValuesCommit?: (values: number[]) => void;
    })
  | (PropertyRowBase & {
      kind: "vector3";
      value: Vector3Value;
      defaultValue?: Vector3Value;
      /** Axis labels; 2D mode hides the Z axis by passing two entries. */
      axes?: string[];
      mixedAxes?: boolean[];
      sensitivity?: number;
      onChange: (value: Vector3Value) => void;
      /** Optional per-axis edit; `onChange` still handles whole-row reset. */
      onAxisChange?: (axis: number, value: number) => void;
      onCommit?: (value: Vector3Value) => void;
      /**
       * While linked, an axis edit scales the other shown axes by the same
       * factor, measured from the values where the edit began. Vertical grids
       * only; `onLinkedChange` adds the link toggle after the label.
       */
      linked?: boolean;
      onLinkedChange?: (linked: boolean) => void;
      /**
       * A multi-selection's per-item values in `axes` order, `value`'s item
       * first. With any item linked, an edit sets the axis on every item, scales
       * each linked item by its own factor and reports them here, not `onChange`.
       */
      itemValues?: Vector3Value[];
      /** Per-item link state; `linked` (pressed only when all are) otherwise. */
      itemLinked?: boolean[];
      onItemValuesChange?: (values: Vector3Value[]) => void;
      /** The end of a per-item edit (a mixed axis, or linked items). */
      onItemValuesCommit?: (values: Vector3Value[]) => void;
    })
  | (PropertyRowBase & {
      kind: "boolean";
      value: boolean;
      defaultValue?: boolean;
      onChange: (value: boolean) => void;
    })
  | (PropertyRowBase & {
      /** A read-only fact shown as selectable text rather than a field (a key count, a time range). */
      kind: "info";
      value: string;
      /** Facts have no default to reset to. */
      defaultValue?: never;
    })
  | (PropertyRowBase & {
      kind: "text";
      /** Keep text focusable and selectable for native copy without allowing edits. */
      readOnly?: boolean;
      /** A three-line text area: Enter adds a line, leaving the field commits, Escape restores. */
      multiline?: boolean;
      value: string;
      defaultValue?: string;
      onChange: (value: string) => void;
      onCommit?: (value: string) => void;
    })
  | (PropertyRowBase & {
      kind: "enum";
      value: string;
      defaultValue?: string;
      options: Array<{ value: string; label: string; disabled?: boolean }>;
      onChange: (value: string) => void;
    })
  | (PropertyRowBase & {
      kind: "color";
      value: ColorValue | null;
      defaultValue?: ColorValue | null;
      onChange: (value: ColorValue) => void;
    })
  | (PropertyRowBase & {
      kind: "slider";
      value: number;
      defaultValue?: number;
      min: number;
      max: number;
      step?: number;
      onChange: (value: number) => void;
      onCommit?: (value: number) => void;
      /** As on number rows: a mixed multi-selection's own values. */
      itemValues?: number[];
      onItemValuesChange?: (values: number[]) => void;
      onItemValuesCommit?: (values: number[]) => void;
    })
  | (PropertyRowBase & {
      kind: "flags";
      value: number;
      defaultValue?: number;
      bitCount?: number;
      labels?: readonly string[];
      onChange: (value: number) => void;
    })
  | (PropertyRowBase & {
      /** Ignore / Overlap / Block per collision layer; full width. */
      kind: "collision-responses";
      value: CollisionResponsesValue;
      defaultValue?: CollisionResponsesValue;
      labels: readonly string[];
      onChange: (value: CollisionResponsesValue) => void;
    })
  | (PropertyRowBase & {
      kind: "asset";
      value: string | null;
      defaultValue?: string | null;
      placeholder?: string;
      /** Human name shown on the picker button; `value` stays the guid. */
      displayLabel?: string;
      /** Secondary type line on the picker button (Texture, Class, …). */
      displayType?: string;
      /** Type glyph on the picker button when a value is selected. */
      visual?: TypeVisualQuery;
      /** Asset types the row accepts, so Paste can offer a copied asset; without it only the current type pastes. */
      assetTypes?: readonly string[];
      onPick: () => void;
      onChange: (value: string | null) => void;
    })
  | (PropertyRowBase & {
      kind: "range";
      /** `[min, max]`; editing one past the other moves both. */
      value: RangeValue;
      defaultValue?: RangeValue;
      min?: number;
      max?: number;
      sensitivity?: number;
      onChange: (value: RangeValue) => void;
      onCommit?: (value: RangeValue) => void;
    })
  | (PropertyRowBase & {
      /** A built-in range Structure value (`{ Min, Max }`); vector and rotator kinds expand per axis. */
      kind: "value-range";
      rangeKind: RangeFieldKind;
      value: RangeFieldValue;
      defaultValue?: RangeFieldValue;
      onChange: (value: RangeFieldValue) => void;
      onCommit?: (value: RangeFieldValue) => void;
    })
  | (PropertyRowBase & {
      /** A built-in curve Structure value (`{ Keys, Before, After }`); expands to the curve editor. */
      kind: "value-curve";
      curveKind: CurveEditorKind;
      value: CurveEditorValue;
      defaultValue?: CurveEditorValue;
      onChange: (value: CurveEditorValue) => void;
    })
  | (PropertyRowBase & {
      kind: "curve";
      value: CurveKey[];
      defaultValue?: CurveKey[];
      valueMin?: number;
      valueMax?: number;
      axisLabels?: { start: string; end: string };
      minKeys?: number;
      maxKeys?: number;
      defaultExpanded?: boolean;
      onChange: (value: CurveKey[]) => void;
    })
  | (PropertyRowBase & {
      kind: "gradient";
      value: GradientStop[];
      defaultValue?: GradientStop[];
      minStops?: number;
      maxStops?: number;
      defaultExpanded?: boolean;
      onChange: (value: GradientStop[]) => void;
    })
  | (PropertyRowBase & {
      kind: "color4";
      /** RGBA, each 0–1; color and alpha edits emit one value. */
      value: Color4Value;
      defaultValue?: Color4Value;
      onChange: (value: Color4Value) => void;
    });

export interface PropertyGridProps {
  rows: PropertyRow[];
  /** Section heading rendered above the rows. */
  title?: string;
  /** Vertical stacks the label above the control (Details). Horizontal is name left, value right. */
  orientation?: "vertical" | "horizontal";
  /** Live inspection: disable edits without dimming the displayed values. */
  readOnly?: boolean;
  /** Screen-reader-only Field labels so the control can fill a list row. */
  hideLabels?: boolean;
  /** Nested list rows: no Field padding or divider. */
  density?: "default" | "compact";
  "data-testid"?: string;
}

function hasDefault(row: PropertyRow): boolean {
  return "defaultValue" in row && row.defaultValue !== undefined;
}

function isAtDefault(row: PropertyRow): boolean {
  if (row.mixed) return false;
  if (!hasDefault(row)) return true;
  const defaultValue = (row as { defaultValue: unknown }).defaultValue;
  if (Object.is(row.value, defaultValue)) return true;
  return JSON.stringify(row.value) === JSON.stringify(defaultValue);
}

/** A numeric row's short unit, which its fields show after the value instead of the label. */
function inlineUnit(row: PropertyRow): string | undefined {
  const numeric = row.kind === "number" || row.kind === "vector3" || row.kind === "slider";
  return numeric && isInlineNumberUnit(row.unit) ? row.unit : undefined;
}

function resetRow(row: PropertyRow): void {
  if (!hasDefault(row)) return;
  switch (row.kind) {
    case "number":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "vector3":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "tag":
      row.onChange(row.defaultValue!);
      break;
    case "tag-container":
      row.onChange(row.defaultValue!);
      break;
    case "boolean":
      row.onChange(row.defaultValue!);
      break;
    case "text":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "enum":
      row.onChange(row.defaultValue!);
      break;
    case "color":
      row.onChange(row.defaultValue!);
      break;
    case "slider":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "flags":
      row.onChange(row.defaultValue!);
      break;
    case "asset":
      row.onChange(row.defaultValue ?? null);
      break;
    case "range":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "value-range":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "value-curve":
      row.onChange(row.defaultValue!);
      break;
    case "curve":
      row.onChange(row.defaultValue!);
      break;
    case "gradient":
      row.onChange(row.defaultValue!);
      break;
    case "color4":
      row.onChange(row.defaultValue!);
      break;
  }
}

/** Labels point only at a single real control; compound rows name their parts. */
function rowHasLabelTarget(row: PropertyRow): boolean {
  switch (row.kind) {
    case "info":
    case "vector3":
    case "flags":
    case "collision-responses":
    case "range":
    case "value-range":
    case "value-curve":
    case "curve":
    case "gradient":
      return false;
    default:
      return true;
  }
}

function TextRowControl({ row }: { row: Extract<PropertyRow, { kind: "text" }> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const baselineRef = useRef(row.value);
  // A mixed multi-selection has no one value to restore: its edit applies
  // only when it finishes, so Escape leaves every item's own text.
  const deferredRef = useRef(false);
  const cancelledRef = useRef(false);
  const handlers = {
    onChange: (event: { target: { value: string } }) => {
      if (row.readOnly) return;
      if (draft === null) {
        baselineRef.current = row.value;
        deferredRef.current = row.mixed === true;
      }
      setDraft(event.target.value);
      if (!deferredRef.current) row.onChange(event.target.value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (row.readOnly || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelledRef.current = true;
        if (draft !== null && !deferredRef.current) row.onChange(baselineRef.current);
        setDraft(null);
        event.currentTarget.blur();
      } else if (event.key === "Enter" && !row.multiline) {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
    onBlur: (event: { target: { value: string } }) => {
      // Focus alone is not an edit; commit only text typed since focus.
      if (!row.readOnly && !cancelledRef.current && draft !== null) {
        if (deferredRef.current) row.onChange(event.target.value);
        row.onCommit?.(event.target.value);
      }
      deferredRef.current = false;
      cancelledRef.current = false;
      setDraft(null);
    },
  };
  if (row.multiline) {
    return <Textarea
      id={`property-${row.id}`}
      rows={3}
      className="min-h-16 resize-y px-2 py-1.5"
      value={draft ?? (row.mixed ? "" : row.value)}
      placeholder={row.mixed ? MIXED_VALUES_LABEL : undefined}
      disabled={row.disabled}
      readOnly={row.readOnly}
      {...handlers}
      data-testid={`property-${row.id}`}
    />;
  }
  return <SelectAllInput
    id={`property-${row.id}`}
    className="min-h-[var(--chrome-row,28px)] px-2"
    value={draft ?? (row.mixed ? "" : row.value)}
    placeholder={row.mixed ? MIXED_VALUES_LABEL : undefined}
    disabled={row.disabled}
    readOnly={row.readOnly}
    {...handlers}
    data-testid={`property-${row.id}`}
  />;
}

type Vector3Row = Extract<PropertyRow, { kind: "vector3" }>;

function Vector3RowControl({ row, name, linkable }: { row: Vector3Row; name: string; linkable: boolean }) {
  const axes = row.axes ?? ["X", "Y", "Z"];
  const items = row.itemValues && row.onItemValuesChange ? row.itemValues : undefined;
  const itemLinked = items?.map((_, index) => row.itemLinked?.[index] ?? row.linked === true);
  const primaryLinked = itemLinked?.[0] ?? row.linked === true;
  const linked = linkable && (itemLinked ? itemLinked.some(Boolean) : primaryLinked);
  // Scaling from where the edit began keeps proportions through typed
  // prefixes ("0" of "0.5") and scrubs that cross zero.
  const linkedEditRef = useRef<{
    value: Vector3Value;
    items?: Vector3Value[];
    latest: Vector3Value;
  } | null>(null);
  // A value changed elsewhere (gizmo, undo) starts the next edit from it.
  useEffect(() => {
    const edit = linkedEditRef.current;
    if (edit && row.value.some((value, index) => !Object.is(value, edit.latest[index])))
      linkedEditRef.current = null;
  });
  const editLinked = (index: number, next: number) => {
    const edit = (linkedEditRef.current ??= {
      value: [...row.value],
      items: items?.map((item) => [...item] as Vector3Value),
      latest: row.value,
    });
    edit.latest = editVectorAxis(edit.value, index, next, axes.length, primaryLinked);
    if (edit.items && row.onItemValuesChange) {
      row.onItemValuesChange(
        edit.items.map((item, itemIndex) =>
          editVectorAxis(item, index, next, axes.length, itemLinked?.[itemIndex] === true),
        ),
      );
    } else {
      row.onChange(edit.latest);
    }
  };
  return (
    <div
      className="flex min-w-0 flex-nowrap gap-1"
      data-testid={`property-vector3-${row.id}`}
    >
      {axes.map((axis, index) => (
        <div key={axis} className="min-w-0 flex-1">
          <NumericDragField
            label={axis}
            aria-label={`${name} ${axis}`}
            value={row.value[index] ?? 0}
            mixed={row.mixedAxes?.[index] ?? row.mixed}
            // An unlinked mixed axis moves each item's axis from its own value.
            itemValues={!linked && items ? items.map((item) => item[index] ?? 0) : undefined}
            onItemsChange={!linked && items && row.onItemValuesChange ? (values) => {
              row.onItemValuesChange!(items.map((item, itemIndex) => {
                const next = [...item] as Vector3Value;
                next[index] = values[itemIndex] ?? next[index]!;
                return next;
              }));
            } : undefined}
            onItemsEnd={!linked && items ? (values) => {
              row.onItemValuesCommit?.(items.map((item, itemIndex) => {
                const next = [...item] as Vector3Value;
                next[index] = values[itemIndex] ?? next[index]!;
                return next;
              }));
            } : undefined}
            accent={axis.toLowerCase() as "x" | "y" | "z"}
            sensitivity={row.sensitivity}
            unit={inlineUnit(row)}
            disabled={row.disabled}
            onChange={(next) => {
              if (linked) {
                editLinked(index, next);
                return;
              }
              if (row.onAxisChange) {
                row.onAxisChange(index, next);
                return;
              }
              const value = [...row.value];
              value[index] = next;
              row.onChange(value as typeof row.value);
            }}
            onDragEnd={(next) => {
              if (linked) {
                const base = linkedEditRef.current?.value ?? row.value;
                linkedEditRef.current = null;
                row.onCommit?.(editVectorAxis(base, index, next, axes.length, primaryLinked));
                return;
              }
              // The finished axis value may not have re-rendered into row.value yet.
              const value = [...row.value];
              value[index] = next;
              row.onCommit?.(value as typeof row.value);
            }}
            data-testid={`property-${row.id}-${axis.toLowerCase()}`}
          />
        </div>
      ))}
    </div>
  );
}

function LinkAxesToggle({
  row,
  name: rowName,
  onLinkedChange,
}: {
  row: Vector3Row;
  name: string;
  onLinkedChange: (linked: boolean) => void;
}) {
  const name = `Link ${rowName} Axes`;
  const linked = row.linked === true;
  const Icon = linked ? Link2Icon : Link2OffIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            className="mr-auto size-6 min-w-6 px-0 text-muted-foreground pointer-coarse:size-[var(--touch-target)]"
            pressed={linked}
            disabled={row.disabled}
            aria-label={name}
            onPressedChange={(pressed) => onLinkedChange(pressed)}
            data-testid={`property-${row.id}-link`}
          />
        }
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

function RowControl({ row, name, linkable = false }: { row: PropertyRow; name: string; linkable?: boolean }) {
  switch (row.kind) {
    case "tag":
      return <TagPicker mode="single" id={`property-${row.id}`} value={row.value} onChange={row.onChange}
        disabled={row.disabled} mixed={row.mixed} aria-label={name} data-testid={`property-${row.id}`} />;
    case "tag-container":
      return <TagPicker mode="multiple" id={`property-${row.id}`} value={row.value} onChange={row.onChange}
        disabled={row.disabled} mixed={row.mixed} aria-label={name} data-testid={`property-${row.id}`} />;
    case "number":
      return (
        <NumericDragField
          id={`property-${row.id}`}
          value={row.value}
          mixed={row.mixed}
          itemValues={row.itemValues}
          onItemsChange={row.onItemValuesChange}
          onItemsEnd={row.onItemValuesCommit}
          min={row.min}
          max={row.max}
          validate={row.validate}
          sensitivity={row.sensitivity}
          precision={row.precision}
          unit={inlineUnit(row)}
          disabled={row.disabled}
          onChange={row.onChange}
          onDragEnd={row.onCommit}
          data-testid={`property-${row.id}`}
        />
      );
    case "vector3":
      return <Vector3RowControl row={row} name={name} linkable={linkable} />;
    case "boolean":
      return (
        <FieldLabel
          htmlFor={`property-${row.id}`}
          className="flex min-h-[var(--chrome-row,28px)] w-full items-center gap-2 rounded-md border border-input bg-control px-2 py-1"
        >
          <Checkbox
            id={`property-${row.id}`}
            aria-labelledby={`property-${row.id}-caption`}
            className="size-4"
            checked={row.mixed ? false : row.value}
            indeterminate={row.mixed}
            disabled={row.disabled}
            onCheckedChange={(checked) => row.onChange(checked === true)}
            data-testid={`property-${row.id}`}
          />
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {row.mixed ? MIXED_VALUES_LABEL : row.value ? "On" : "Off"}
          </span>
        </FieldLabel>
      );
    case "info":
      return (
        <span id={`property-${row.id}`} className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center px-2 text-sm text-muted-foreground tabular-nums" data-testid={`property-${row.id}`}>
          <SelectableText className="min-w-0 truncate">{row.value}</SelectableText>
        </span>
      );
    case "text":
      return <TextRowControl row={row} />;
    case "enum":
      return (
        <Select
          value={row.value}
          disabled={row.disabled}
          onValueChange={(value) => row.onChange(String(value))}
        >
          <SelectTrigger
            id={`property-${row.id}`}
            className="min-h-[var(--chrome-row,28px)] w-full"
            disabled={row.disabled}
            data-testid={`property-${row.id}`}
          >
            {/* Base UI renders the raw value unless the label is formatted. */}
            <SelectValue>
              {(value: unknown) =>
                row.mixed
                  ? MIXED_VALUES_LABEL
                  : humanizePropertyLabel(
                    row.options.find((option) => option.value === value)?.label ??
                      String(value ?? ""),
                  )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {row.options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {humanizePropertyLabel(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "color":
      return (
        <ColorField
          id={`property-${row.id}`}
          aria-label={name}
          value={row.value}
          mixed={row.mixed}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "slider":
      return (
        <div className="flex min-w-0 items-center gap-2">
          <Slider
            aria-label={name}
            className="min-w-0 flex-1"
            value={row.value}
            min={row.min}
            max={row.max}
            step={row.step ?? (row.max - row.min <= 1 ? 0.01 : 1)}
            disabled={row.disabled}
            onValueChange={(next) => {
              const value = Array.isArray(next) ? next[0] : next;
              if (typeof value === "number") row.onChange(value);
            }}
            onValueCommitted={(next) => {
              const value = Array.isArray(next) ? next[0] : next;
              if (typeof value === "number") row.onCommit?.(value);
            }}
            data-testid={`property-${row.id}-slider`}
          />
          <div className="w-20 shrink-0">
            <NumericDragField
              id={`property-${row.id}`}
              value={row.value}
              mixed={row.mixed}
              itemValues={row.itemValues}
              onItemsChange={row.onItemValuesChange}
              onItemsEnd={row.onItemValuesCommit}
              min={row.min}
              max={row.max}
              unit={inlineUnit(row)}
              disabled={row.disabled}
              onChange={row.onChange}
              onDragEnd={row.onCommit}
              data-testid={`property-${row.id}`}
            />
          </div>
        </div>
      );
    case "collision-responses":
      return (
        <CollisionResponsesField
          layers={row.labels}
          value={row.value}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "flags":
      return (
        <FlagsField
          id={`property-${row.id}`}
          value={row.value}
          bitCount={row.bitCount}
          labels={row.labels}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "asset": {
      const selected = Boolean(row.displayLabel ?? row.value);
      return (
        <AssetPickerControl value={row.value}>
          <Button
            id={`property-${row.id}`}
            variant="outline"
            className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
            disabled={row.disabled}
            onClick={row.onPick}
            data-testid={`property-${row.id}`}
          >
            {row.mixed ? (
              <span className="truncate">{MIXED_VALUES_LABEL}</span>
            ) : selected && (row.visual || row.displayType) ? (
              <PickerIdentity
                label={
                  row.displayLabel ?? row.value ?? row.placeholder ?? "None"
                }
                description={row.displayType}
                visual={row.visual}
              />
            ) : (
              <span className="truncate">{row.displayLabel ?? row.value ?? row.placeholder ?? "None"}</span>
            )}
          </Button>
        </AssetPickerControl>
      );
    }
    case "range": {
      const [low, high] = row.value;
      const tuple = (next: RangeFieldValue): RangeValue => [Number(next.Min), Number(next.Max)];
      return (
        <RangeField
          kind="float"
          aria-label={name}
          value={{ Min: low, Max: high }}
          mixed={row.mixed}
          min={row.min}
          max={row.max}
          sensitivity={row.sensitivity}
          disabled={row.disabled}
          onChange={(next) => row.onChange(tuple(next))}
          onCommit={(next) => row.onCommit?.(tuple(next))}
          data-testid={`property-${row.id}`}
        />
      );
    }
    case "value-range":
      return (
        <RangeField
          kind={row.rangeKind}
          aria-label={name}
          value={row.value}
          unit={row.unit}
          mixed={row.mixed}
          disabled={row.disabled}
          onChange={row.onChange}
          onCommit={row.onCommit}
          data-testid={`property-${row.id}`}
        />
      );
    case "value-curve":
      return (
        <CurveValueField
          kind={row.curveKind}
          aria-label={name}
          value={row.value}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "curve":
      return (
        <CurveField
          id={`property-${row.id}`}
          aria-label={name}
          value={row.value}
          valueMin={row.valueMin}
          valueMax={row.valueMax}
          axisLabels={row.axisLabels}
          minKeys={row.minKeys}
          maxKeys={row.maxKeys}
          defaultExpanded={row.defaultExpanded}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "gradient":
      return (
        <GradientField
          id={`property-${row.id}`}
          aria-label={name}
          value={row.value}
          minStops={row.minStops}
          maxStops={row.maxStops}
          defaultExpanded={row.defaultExpanded}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "color4": {
      const [r, g, b, a] = row.value;
      return (
        <ColorField
          id={`property-${row.id}`}
          aria-label={name}
          value={[r, g, b]}
          alpha={a}
          mixed={row.mixed}
          alphaMixed={row.mixed}
          disabled={row.disabled}
          onChange={([nextR, nextG, nextB]) => row.onChange([nextR, nextG, nextB, a])}
          onAlphaChange={(alpha) => row.onChange([r, g, b, alpha])}
          data-testid={`property-${row.id}`}
        />
      );
    }
  }
}

function rowResetButton(row: PropertyRow, name: string) {
  if (!hasDefault(row) || row.disabled || (row.kind === "text" && row.readOnly)) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      disabled={isAtDefault(row)}
      aria-label={`Reset ${name}`}
      onClick={() => resetRow(row)}
      data-testid={`property-${row.id}-reset`}
    >
      <span aria-hidden="true">↺</span>
    </Button>
  );
}

function readOnlyPropertyRow(row: PropertyRow): PropertyRow {
  const next = { ...row, disabled: true, onChange: () => {} };
  if ("onCommit" in next) next.onCommit = undefined;
  if ("onAxisChange" in next) next.onAxisChange = undefined;
  if ("onItemValuesChange" in next) next.onItemValuesChange = undefined;
  if ("onPick" in next) next.onPick = () => {};
  return next;
}

/** A text field being typed in keeps the browser's own Cut / Copy / Paste menu. */
function isEditingText(target: Element): boolean {
  const field = target.closest("input, textarea, [contenteditable='true']");
  if (!field || field !== document.activeElement) return false;
  return !(field instanceof HTMLInputElement) || ["text", "search", "number", "email", "url", "tel", "password"].includes(field.type);
}

/**
 * Right-click or long-press on a row or its title opens Copy and Paste for that
 * row's value. One menu serves the grid; nested grids keep their own rows.
 */
function usePropertyRowMenu(rows: PropertyRow[], readOnly: boolean) {
  const gridRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef({ rows, readOnly });
  useLayoutEffect(() => {
    latestRef.current = { rows, readOnly };
  });
  const rowIdRef = useRef<string | null>(null);
  // A right press focuses a field before contextmenu fires, so whether the
  // user was typing is read at the press.
  const pressRef = useRef<{ target: EventTarget | null; editing: boolean } | null>(null);
  const { menu, closeMenu, bind } = useContextMenu({
    items: (): ContextMenuItem[] => {
      const { rows: current, readOnly: locked } = latestRef.current;
      const source = current.find((row) => row.id === rowIdRef.current);
      if (!source) return [];
      const row = locked ? readOnlyPropertyRow(source) : source;
      return [
        {
          id: "property-copy",
          label: "Copy",
          icon: <CopyIcon />,
          disabled: !canCopyPropertyRow(row),
          onSelect: () => copyPropertyRow(row),
        },
        {
          id: "property-paste",
          label: "Paste",
          icon: <ClipboardPasteIcon />,
          disabled: !canPastePropertyRow(row),
          onSelect: () => pastePropertyRow(row),
        },
      ];
    },
  });
  /** The row of this grid under the event, unless it belongs to a nested grid or the user is typing. */
  const rowIdFor = (event: { target: EventTarget | null }, editing: boolean): string | null => {
    const target = event.target;
    if (!(target instanceof Element) || editing) return null;
    const rowElement = target.closest("[data-property-row-id]");
    if (!rowElement || rowElement.closest('[data-slot="property-grid"]') !== gridRef.current) return null;
    return rowElement.getAttribute("data-property-row-id");
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    const editing = event.target instanceof Element && isEditingText(event.target);
    pressRef.current = { target: event.target, editing };
    const id = rowIdFor(event, editing);
    if (!id) return;
    rowIdRef.current = id;
    bind.onPointerDown(event);
    claimContextMenuEvent(event);
  };
  const onContextMenu = (event: ReactMouseEvent) => {
    const press = pressRef.current;
    const editing = press && press.target === event.target
      ? press.editing
      : event.target instanceof Element && isEditingText(event.target);
    const id = rowIdFor(event, editing);
    if (!id) return;
    rowIdRef.current = id;
    bind.onContextMenu(event);
    claimContextMenuEvent(event);
    event.stopPropagation();
  };
  return {
    gridRef,
    menu,
    closeMenu,
    handlers: {
      onPointerDown,
      onContextMenu,
      onPointerMove: bind.onPointerMove,
      onPointerUp: bind.onPointerUp,
      onPointerCancel: bind.onPointerCancel,
    },
  };
}

/** PropertyGrid section band, for Details sections that mix property rows with lists or summaries. */
export function PropertySectionTitle({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <h3 className="flex min-w-0 items-center gap-2 bg-panel-header px-2 py-1.5 text-xs font-semibold text-foreground">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside}
    </h3>
  );
}

/** Typed property rows with per-property reset-to-default (engineplan §7.4). */
export function PropertyGrid({
  rows,
  title,
  orientation = "vertical",
  readOnly: readOnlyProp = false,
  hideLabels = false,
  density = "default",
  "data-testid": testId,
}: PropertyGridProps) {
  const inheritedReadOnly = useEditorReadOnly();
  const readOnly = readOnlyProp || inheritedReadOnly;
  const compact = density === "compact";
  const rowMenu = usePropertyRowMenu(rows, readOnly);
  return (
    <div
      ref={rowMenu.gridRef}
      {...rowMenu.handlers}
      className="flex min-w-0 flex-col gap-0"
      data-slot="property-grid"
      data-readonly={readOnly || undefined}
      data-hide-labels={hideLabels || undefined}
      data-density={density}
      data-testid={testId}
    >
      {title ? <PropertySectionTitle>{title}</PropertySectionTitle> : null}
      <FieldGroup className="gap-0">
        {rows.map((source) => {
          const row = readOnly ? readOnlyPropertyRow(source) : source;
          const name = humanizePropertyLabel(row.label);
          const onLinkedChange =
            orientation === "vertical" && row.kind === "vector3" ? row.onLinkedChange : undefined;
          const label = (
            <FieldLabel
              id={`property-${row.id}-caption`}
              htmlFor={rowHasLabelTarget(row) ? `property-${row.id}` : undefined}
              className={
                hideLabels
                  ? "sr-only"
                  : cn(
                      "w-auto min-w-0 truncate",
                      !onLinkedChange && "flex-1",
                      row.unit && !inlineUnit(row) && "gap-1",
                    )
              }
            >
              {name}
              {row.unit && !inlineUnit(row) ? (
                <span className="font-normal text-muted-foreground">
                  {` (${row.unit})`}
                </span>
              ) : null}
            </FieldLabel>
          );
          const hinted = row.description && !hideLabels ? <LabelHint hint={row.description}>{label}</LabelHint> : label;
          // Screen readers keep the explanation as the control's description.
          const description = (
            <>
              {row.description ? <FieldDescription className="sr-only">{row.description}</FieldDescription> : null}
              {row.status ? <FieldDescription data-row-status="">{row.status}</FieldDescription> : null}
              {row.error ? <FieldError>{row.error}</FieldError> : null}
            </>
          );
          return (
            <Field
              key={row.id}
              orientation={orientation}
              data-property-row-id={row.id}
              data-testid={row.testId ?? `property-row-${row.id}`}
              data-disabled={row.disabled || undefined}
              data-invalid={row.error ? true : undefined}
              data-kind={row.kind}
              className={
                compact
                  ? "gap-0.5 px-0 py-0"
                  : "gap-0.5 border-b border-border/30 px-2 py-1"
              }
            >
              {orientation === "horizontal" ? (
                <>
                  {hinted}
                  <FieldContent className="min-w-0">
                    <RowControl row={row} name={name} />
                    {description}
                  </FieldContent>
                </>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-1">
                    {hinted}
                    {onLinkedChange && row.kind === "vector3" ? (
                      <LinkAxesToggle row={row} name={name} onLinkedChange={onLinkedChange} />
                    ) : null}
                    {row.labelAccessory}
                    {rowResetButton(row, name)}
                  </div>
                  <div className="min-w-0">
                    <RowControl row={row} name={name} linkable />
                    {description}
                  </div>
                </>
              )}
            </Field>
          );
        })}
      </FieldGroup>
      {rowMenu.menu ? (
        <ContextMenuOverlay menu={rowMenu.menu} onClose={rowMenu.closeMenu} contentTestId="property-context-menu" />
      ) : null}
    </div>
  );
}
