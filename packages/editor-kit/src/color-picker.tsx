import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@babylonslate/ui/components/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@babylonslate/ui/components/field";
import { Separator } from "@babylonslate/ui/components/separator";
import { Slider } from "@babylonslate/ui/components/slider";
import { cn } from "@babylonslate/ui/lib/utils";
import { popupMenuFrame } from "./catalog-menu";
import { colorToHex, parseHexColor, type ColorValue } from "./color-field";
import { isCoarsePointerEnvironment } from "./prevent-document-overscroll";
import { SelectAllInput } from "./select-all-input";

type Rgba = [number, number, number, number];
type Hsv = [number, number, number];

export interface ColorPickerProps {
  value: Rgba;
  /** Show opacity controls. RGB-only fields retain the supplied alpha value. */
  withAlpha?: boolean;
  /** Emitted once on Done, only when the authored color has changed. */
  onChange: (value: Rgba) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

interface ColorDraft {
  source: Rgba;
  withAlpha: boolean;
  color: Rgba;
  hsv: Hsv;
  hex: string;
  alpha: string;
  anchor: { x: number; y: number };
}

const CHECKERBOARD = "conic-gradient(var(--muted) 0.25turn, var(--border) 0 0.5turn, var(--muted) 0 0.75turn, var(--border) 0) 0 0 / 8px 8px";
const HUE_GRADIENT = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rgb(color: Rgba): ColorValue {
  return [color[0], color[1], color[2]];
}

function sameColor(a: Rgba, b: Rgba): boolean {
  return a.every((channel, index) => Object.is(channel, b[index]));
}

function colorBackground(color: Rgba): string {
  const css = `rgb(${clampUnit(color[0]) * 255} ${clampUnit(color[1]) * 255} ${clampUnit(color[2]) * 255} / ${clampUnit(color[3])})`;
  return `linear-gradient(${css}, ${css}), ${CHECKERBOARD}`;
}

function toHsv(color: Rgba): Hsv {
  const [r, g, b] = rgb(color).map(clampUnit) as ColorValue;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === r) hue = (g - b) / delta;
    else if (maximum === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
  }
  return [hue, maximum === 0 ? 0 : delta / maximum, maximum];
}

function fromHsv([hue, saturation, brightness]: Hsv): ColorValue {
  const chroma = brightness * saturation;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const offset = brightness - chroma;
  const channels: ColorValue = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
    : sector < 3 ? [0, chroma, secondary]
    : sector < 4 ? [0, secondary, chroma]
    : sector < 5 ? [secondary, 0, chroma]
    : [chroma, 0, secondary];
  return channels.map((channel) => channel + offset) as ColorValue;
}

function editHsv(draft: ColorDraft, hsv: Hsv): ColorDraft {
  const color: Rgba = [...fromHsv(hsv), draft.color[3]];
  return { ...draft, color, hsv, hex: colorToHex(rgb(color)) };
}

/** A compact swatch opening a direct color palette with a single final commit. */
export function ColorPicker({
  value,
  withAlpha = true,
  onChange,
  disabled = false,
  className,
  "aria-label": ariaLabel = "Select Color",
  "data-testid": testId = "color-picker",
}: ColorPickerProps) {
  const [draft, setDraft] = useState<ColorDraft | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; start: ColorDraft } | null>(null);
  const id = useId();
  const coarse = isCoarsePointerEnvironment();
  const current = draft && !disabled && draft.withAlpha === withAlpha && sameColor(draft.source, value) ? draft : null;

  // Drop a stale draft while rendering; opening the palette resets the drag.
  if (draft && !current) setDraft(null);

  const close = () => {
    dragRef.current = null;
    setDraft(null);
  };
  const updatePalette = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const saturation = clampUnit((event.clientX - bounds.left) / bounds.width);
    const brightness = 1 - clampUnit((event.clientY - bounds.top) / bounds.height);
    setDraft((previous) => previous ? editHsv(previous, [previous.hsv[0], saturation, brightness]) : null);
  };
  const paletteKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const [hue, saturation, brightness] = current.hsv;
    const step = event.shiftKey ? 0.1 : 0.01;
    let next: Hsv;
    switch (event.key) {
      case "ArrowLeft": next = [hue, clampUnit(saturation - step), brightness]; break;
      case "ArrowRight": next = [hue, clampUnit(saturation + step), brightness]; break;
      case "ArrowDown": next = [hue, saturation, clampUnit(brightness - step)]; break;
      case "ArrowUp": next = [hue, saturation, clampUnit(brightness + step)]; break;
      case "Home": next = [hue, 0, brightness]; break;
      case "End": next = [hue, 1, brightness]; break;
      default: return;
    }
    event.preventDefault();
    setDraft(editHsv(current, next));
  };
  const invalidHex = current !== null && !parseHexColor(current.hex);
  const invalidAlpha = current !== null && withAlpha && (
    current.alpha.trim() === "" || !Number.isFinite(Number(current.alpha)) || Number(current.alpha) < 0 || Number(current.alpha) > 1
  );

  return <>
    <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={disabled}
      className={cn("min-w-0 gap-1.5 px-1.5 [@media(pointer:coarse)]:min-h-11", className)}
      aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={Boolean(current)} data-testid={testId}
      title={colorToHex(rgb(value))}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        dragRef.current = null;
        setDraft({ source: [...value], color: [...value], hsv: toHsv(value), withAlpha,
          hex: colorToHex(rgb(value)), alpha: String(value[3]), anchor: { x: bounds.left, y: bounds.bottom + 4 } });
      }}>
      <span className="h-3.5 min-w-6 flex-1 rounded-sm border border-border" style={{ background: colorBackground(value) }} aria-hidden="true" />
      <ChevronDownIcon data-icon="inline-end" />
    </Button>
    {current ? <Dialog open onOpenChange={(open, details) => {
      if (details.reason === "escape-key" && (details.event.isComposing || details.event.keyCode === 229)) {
        details.cancel();
        return;
      }
      if (!open) close();
    }}>
      <DialogContent showCloseButton={false} overlayClassName="catalog-menu-overlay bg-transparent"
        finalFocus={triggerRef} initialFocus={paletteRef}
        className="catalog-menu catalog-menu-popup flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-none"
        style={popupMenuFrame(current.anchor, { width: 360, height: withAlpha ? (coarse ? 492 : 440) : (coarse ? 420 : 368) })}
        data-testid={`${testId}-dialog`}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}>
        <div className="shrink-0 px-3 pt-3 pb-2">
          <DialogTitle className="text-sm">Select Color</DialogTitle>
        </div>
        <FieldGroup className="min-h-0 flex-1 gap-3 overflow-y-auto px-3 pb-3">
          <div ref={paletteRef} role="slider" tabIndex={0} aria-label="Saturation And Brightness"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(current.hsv[1] * 100)}
            aria-valuetext={`Saturation ${Math.round(current.hsv[1] * 100)}%, Brightness ${Math.round(current.hsv[2] * 100)}%`}
            aria-describedby={`${id}-palette-help`}
            data-testid={`${testId}-palette`}
            className="relative h-40 min-h-40 shrink-0 touch-none rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${current.hsv[0]} 100% 50%)` }}
            onKeyDown={paletteKey}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.isPrimary === false) return;
              event.preventDefault();
              event.currentTarget.focus();
              dragRef.current = { pointerId: event.pointerId, start: current };
              event.currentTarget.setPointerCapture?.(event.pointerId);
              updatePalette(event);
            }}
            onPointerMove={(event) => { if (dragRef.current?.pointerId === event.pointerId) updatePalette(event); }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return;
              updatePalette(event);
              dragRef.current = null;
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return;
              setDraft(dragRef.current.start);
              dragRef.current = null;
            }}>
            <span aria-hidden="true" className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ring-1 ring-black/70"
              style={{ left: `${current.hsv[1] * 100}%`, top: `${(1 - current.hsv[2]) * 100}%` }} />
          </div>
          <span id={`${id}-palette-help`} className="sr-only">Use Left and Right for saturation, Up and Down for brightness. Hold Shift for larger changes.</span>
          <Field className="gap-0">
            <FieldLabel id={`${id}-hue-label`} className="text-xs">Hue</FieldLabel>
            <Slider aria-labelledby={`${id}-hue-label`} min={0} max={360} step={1} value={current.hsv[0]}
              className="[&_[data-slot=slider-track]]:h-3 [&_[data-slot=slider-track]]:[background:var(--color-picker-track)] [&_[data-slot=slider-range]]:bg-transparent"
              style={{ "--color-picker-track": HUE_GRADIENT } as CSSProperties}
              onValueChange={(next) => setDraft((previous) => previous ? editHsv(previous, [Array.isArray(next) ? next[0]! : next, previous.hsv[1], previous.hsv[2]]) : null)} />
          </Field>
          <div className="flex items-end gap-3">
            <div className="flex shrink-0 gap-2">
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>Before</span>
                <span className="h-7 w-10 rounded-sm border border-border [@media(pointer:coarse)]:h-11" style={{ background: colorBackground(current.source) }} aria-hidden="true" />
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>After</span>
                <span className="h-7 w-10 rounded-sm border border-border [@media(pointer:coarse)]:h-11" style={{ background: colorBackground(current.color) }} aria-hidden="true" />
              </div>
            </div>
            <Field className="min-w-0 flex-1 gap-1" data-invalid={invalidHex || undefined}>
              <FieldLabel htmlFor={`${id}-hex`} className="text-xs">Hex</FieldLabel>
              <SelectAllInput id={`${id}-hex`} value={current.hex} spellCheck={false} autoComplete="off"
                className="h-7 min-h-7 font-mono [@media(pointer:coarse)]:min-h-11"
                aria-invalid={invalidHex || undefined} aria-describedby={invalidHex ? `${id}-hex-error` : undefined}
                data-testid={`${testId}-hex`}
                onChange={(event) => {
                  const hex = event.target.value;
                  setDraft((previous) => {
                    if (!previous) return null;
                    const parsed = parseHexColor(hex);
                    if (!parsed) return { ...previous, hex };
                    const color: Rgba = [...parsed, previous.color[3]];
                    return { ...previous, color, hsv: toHsv(color), hex };
                  });
                }} />
            </Field>
          </div>
          {invalidHex ? <FieldError id={`${id}-hex-error`}>Use a 3- or 6-digit hex color.</FieldError> : null}
          {withAlpha ? <Field className="gap-0" data-invalid={invalidAlpha || undefined}>
            <FieldLabel htmlFor={`${id}-alpha`} className="text-xs">Alpha</FieldLabel>
            <div className="flex items-center gap-3">
              <Slider aria-label="Alpha" min={0} max={1} step={0.01} value={clampUnit(current.color[3])}
                className="min-w-0 flex-1 [&_[data-slot=slider-track]]:h-3 [&_[data-slot=slider-track]]:[background:var(--color-picker-track)] [&_[data-slot=slider-range]]:bg-transparent"
                style={{ "--color-picker-track": `linear-gradient(to right, transparent, ${colorToHex(rgb(current.color))}), ${CHECKERBOARD}` } as CSSProperties}
                onValueChange={(next) => {
                  const alpha = Array.isArray(next) ? next[0]! : next;
                  setDraft((previous) => previous ? { ...previous, color: [...rgb(previous.color), alpha], alpha: String(alpha) } : null);
                }} />
              <SelectAllInput id={`${id}-alpha`} aria-label="Alpha Value" value={current.alpha} inputMode="decimal"
                className="h-7 min-h-7 w-16 [@media(pointer:coarse)]:min-h-11"
                aria-invalid={invalidAlpha || undefined} aria-describedby={invalidAlpha ? `${id}-alpha-error` : undefined}
                data-testid={`${testId}-alpha`}
                onChange={(event) => {
                  const alpha = event.target.value;
                  const parsed = Number(alpha);
                  setDraft((previous) => previous ? { ...previous, alpha, color: alpha.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? [...rgb(previous.color), parsed] : previous.color } : null);
                }} />
            </div>
            {invalidAlpha ? <FieldError id={`${id}-alpha-error`}>Use an alpha value from 0 to 1.</FieldError> : null}
          </Field> : null}
        </FieldGroup>
        <Separator />
        <div className="flex shrink-0 items-center justify-end gap-2 px-3 py-2">
          <Button type="button" size={coarse ? "touch" : "sm"} variant="outline" onClick={close}>Cancel</Button>
          <Button type="button" size={coarse ? "touch" : "sm"} disabled={invalidHex || invalidAlpha}
            onClick={() => {
              if (disabled || invalidHex || invalidAlpha) return;
              const changed = !sameColor(current.color, value);
              const next = current.color;
              close();
              if (changed) onChange(next);
            }}>Done</Button>
        </div>
      </DialogContent>
    </Dialog> : null}
  </>;
}
