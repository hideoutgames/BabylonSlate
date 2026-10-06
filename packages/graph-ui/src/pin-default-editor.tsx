import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ColorPicker,
  NumericDragField,
  TagPicker,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Input } from "@babylonslate/ui/components/input";
import { FieldLabel } from "@babylonslate/ui/components/field";
import {
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  vec3TupleToObject,
  vec4TupleToObject,
} from "@babylonslate/scripting";
import type { PinDefaultEditorRenderer, PinDefaultEditorRequest } from "./pin-default-editor-context";
import { PinDefaultPreviewWidget } from "./pin-default-widget";

type EditorProps = PinDefaultEditorRequest & { renderer?: PinDefaultEditorRenderer };

function StringDefault({ value, disabled, onChange, label, testId }: {
  value: unknown; disabled: boolean; onChange: (value: unknown) => void; label: string; testId: string;
}) {
  const text = pinDefaultAsString(value);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return <Input value={draft ?? text} disabled={disabled} aria-label={label} data-testid={testId}
    className="graph-pin-default-input h-8 w-36 min-w-16 text-base"
    onFocus={(event) => { cancelled.current = false; event.currentTarget.select(); }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => {
      if (!disabled && !cancelled.current && draft !== null && draft !== text) onChange(draft);
      cancelled.current = false;
      setDraft(null);
    }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault(); cancelled.current = true; setDraft(null); event.currentTarget.blur();
      } else if (event.key === "Enter") {
        event.preventDefault(); event.currentTarget.blur();
      }
    }} />;
}

function NumberDefault({ value, integer, disabled, onChange, label, testId, min, max, axis, accent }: {
  value: unknown; integer: boolean; disabled: boolean; onChange: (value: unknown) => void; label: string; testId: string;
  min?: number; max?: number; axis?: string; accent?: "x" | "y" | "z";
}) {
  const number = pinDefaultAsNumber(value);
  const [draft, setDraft] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const cancel = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault(); event.stopPropagation();
    setDraft(null);
    // Unmount the active field so its blur callback cannot commit the cancelled draft.
    setRevision((current) => current + 1);
  };
  return <div className={axis ? "graph-pin-default-component w-16 min-w-0" : "graph-pin-default-number w-24"} onKeyDownCapture={cancel}>
    <NumericDragField key={revision} value={draft ?? number} precision={integer ? 0 : undefined} label={axis} accent={accent}
      sensitivity={integer ? 1 : 0.01} min={min} max={max} disabled={disabled} aria-label={label} data-testid={testId}
      onChange={(next) => setDraft(integer ? Math.trunc(next) : next)}
      onDragEnd={(next) => {
        const normalized = integer ? Math.trunc(next) : next;
        if (!disabled && normalized !== number) onChange(normalized);
        setDraft(null);
      }} />
  </div>;
}

function VectorDefault(request: PinDefaultEditorRequest & { testId: string }) {
  const kind = request.preview.kind;
  const keys = kind === "rotator" ? ["pitch", "yaw", "roll"] as const
    : kind === "vec2" ? ["x", "y"] as const
      : kind === "vec3" ? ["x", "y", "z"] as const : ["x", "y", "z", "w"] as const;
  const values = keys.length === 4 ? pinDefaultAsVec4Tuple(request.value) : pinDefaultAsVec3Tuple(request.value, keys);
  const label = humanizePropertyLabel(request.pin.name);
  return <div className="graph-pin-default-vector flex items-center gap-1">
    {keys.map((key, index) => <NumberDefault
      key={JSON.stringify([request.nodeId, request.pin.id, request.pin.type, request.pin.min, request.pin.max, key, values[index], request.disabled])}
      value={values[index]} integer={false} disabled={request.disabled}
      axis={kind === "rotator" ? ["P", "Y", "R"][index] : key.toUpperCase()}
      accent={index < 3 ? ["x", "y", "z"][index] as "x" | "y" | "z" : undefined}
      label={`${label} ${humanizePropertyLabel(key)}`} testId={`${request.testId}-${key}`}
      min={request.pin.min} max={request.pin.max}
      onChange={(next) => {
        const updated = [...values];
        updated[index] = pinDefaultAsNumber(next);
        request.onChange(keys.length === 4
          ? vec4TupleToObject(updated as [number, number, number, number])
          : vec3TupleToObject(updated as [number, number, number], keys));
      }} />)}
  </div>;
}

/** Editable literal defaults stay independent of node dragging and graph shortcuts. */
export function PinDefaultEditor(request: EditorProps) {
  const { nodeId, pin, preview, value, disabled, onChange, renderer } = request;
  const checkboxId = useId();
  const label = humanizePropertyLabel(pin.name);
  const testId = `pin-default-${nodeId}-${pin.id}`;
  // An authoritative update discards local text and scalar drafts.
  const draftKey = () => JSON.stringify([nodeId, pin.id, pin.type, preview.kind, pin.min, pin.max, value, disabled]);
  let control;
  switch (preview.kind) {
    case "tag":
      control = <TagPicker mode="single" value={preview.value} onChange={onChange} disabled={disabled}
        className="max-w-[var(--graph-pin-default-max-width,12rem)]" aria-label={`${label} Tag`} data-testid={`pin-tag-${nodeId}-${pin.id}`} />;
      break;
    case "tag-container":
      control = <TagPicker mode="multiple" value={preview.value} onChange={onChange} disabled={disabled}
        className="max-w-[var(--graph-pin-default-max-width,12rem)]" aria-label={`${label} Tags`} data-testid={`pin-tags-${nodeId}-${pin.id}`} />;
      break;
    case "bool":
      control = <FieldLabel htmlFor={checkboxId} className="graph-pin-default-boolean flex min-h-8 items-center gap-1.5">
        <Checkbox id={checkboxId} checked={pinDefaultAsBoolean(value)} disabled={disabled} aria-label={label} data-testid={testId}
          onCheckedChange={(checked) => { if (!disabled) onChange(checked === true); }} />
        <span className="text-sm">{pinDefaultAsBoolean(value) ? "On" : "Off"}</span>
      </FieldLabel>;
      break;
    case "string":
      control = <StringDefault key={draftKey()} value={value} disabled={disabled} onChange={onChange} label={label} testId={testId} />;
      break;
    case "int":
    case "float":
      control = <NumberDefault key={draftKey()} value={value} integer={preview.kind === "int"} disabled={disabled} onChange={onChange} label={label} testId={testId}
        min={pin.min} max={pin.max} />;
      break;
    case "vec2": case "vec3": case "vec4": case "quat": case "rotator":
      control = <VectorDefault {...request} testId={testId} />;
      break;
    case "color":
      control = <ColorPicker key={`${nodeId}:${pin.id}:${pin.type.kind}`} value={pinDefaultAsVec4Tuple(value)}
        withAlpha={!(pin.colorHint && pin.type.kind === "vec3")} disabled={disabled}
        onChange={(next) => onChange(vec4TupleToObject(next))} aria-label={`Edit ${label}`} data-testid={testId}
        className="graph-pin-default-button h-8 w-16" />;
      break;
    case "enumRef": case "classRef": case "assetRef":
      control = renderer?.(request) ?? <PinDefaultPreviewWidget preview={preview} />;
      break;
    default:
      return <PinDefaultPreviewWidget preview={preview} />;
  }
  return <div className="nodrag nopan nowheel graph-pin-default-editor shrink-0" data-pin-default={preview.kind}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    {control}
  </div>;
}
