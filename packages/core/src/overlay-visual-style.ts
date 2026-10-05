/** Multipliers belong to one visual component, never its shared material asset. */
export type OverlayVisualStyle = { opacity: number; tint: [number, number, number, number] };

const classes = new Set(["2DTextureComponent", "2DMaterialComponent", "2DPanelComponent", "2DTextComponent", "2DRichTextComponent", "2DPainterComponent", "2DJoystickComponent"]);
export function supportsOverlayVisualStyle(classId: string): boolean { return classes.has(classId); }

export function parseOverlayVisualStyle(value: unknown): OverlayVisualStyle {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const finite = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const raw = source.tint as Record<string, unknown> | unknown[] | undefined;
  const tint = Array.isArray(raw) ? raw : raw ? [raw.x ?? raw.r, raw.y ?? raw.g, raw.z ?? raw.b, raw.w ?? raw.a] : [];
  return {
    opacity: Math.max(0, Math.min(1, finite(source.opacity, 1))),
    tint: [Math.max(0, finite(tint[0], 1)), Math.max(0, finite(tint[1], 1)), Math.max(0, finite(tint[2], 1)), Math.max(0, Math.min(1, finite(tint[3], 1)))],
  };
}
