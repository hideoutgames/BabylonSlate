export interface MaterialGradientStop { position: number; color: [number, number, number] }

export function materialGradientStops(value: unknown): MaterialGradientStop[] {
  if (!Array.isArray(value) || value.length < 2) return [{ position: 0, color: [0, 0, 0] }, { position: 1, color: [1, 1, 1] }];
  return value.slice(0, 32).map((stop: unknown): MaterialGradientStop => {
    const record = stop && typeof stop === "object" ? stop as Record<string, unknown> : {};
    const position = typeof record.position === "number" && Number.isFinite(record.position) ? Math.min(1, Math.max(0, record.position)) : 0;
    const color = Array.isArray(record.color) ? record.color : [];
    const component = (i: number) => typeof color[i] === "number" && Number.isFinite(color[i]) ? color[i] as number : 0;
    return { position, color: [component(0), component(1), component(2)] };
  }).sort((a, b) => a.position - b.position);
}
