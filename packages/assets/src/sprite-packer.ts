export interface PackInput {
  id: string;
  width: number;
  height: number;
}

export interface PackedRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackResult {
  width: number;
  height: number;
  padding: number;
  extrusion: number;
  rects: PackedRect[];
}

function nextPow2(value: number): number {
  let n = 1;
  while (n < value) n *= 2;
  return n;
}

/**
 * Deterministic shelf packer: sort by height desc then id, place left-to-right
 * with padding and edge extrusion around each frame.
 */
export function packRectangles(
  frames: readonly PackInput[],
  options: { padding?: number; extrusion?: number; powerOfTwo?: boolean } = {},
): PackResult {
  const padding = options.padding ?? 2;
  const extrusion = options.extrusion ?? 1;
  const ordered = [...frames].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return a.id.localeCompare(b.id);
  });

  const rects: PackedRect[] = [];
  let x = padding;
  let y = padding;
  let rowHeight = 0;
  let width = padding;
  let height = padding;

  for (const frame of ordered) {
    const w = frame.width + extrusion * 2;
    const h = frame.height + extrusion * 2;
    if (rects.length > 0 && x + w + padding > Math.max(width, 256)) {
      x = padding;
      y += rowHeight + padding;
      rowHeight = 0;
    }
    rects.push({
      id: frame.id,
      x: x + extrusion,
      y: y + extrusion,
      width: frame.width,
      height: frame.height,
    });
    x += w + padding;
    rowHeight = Math.max(rowHeight, h);
    width = Math.max(width, x);
    height = Math.max(height, y + rowHeight + padding);
  }

  if (options.powerOfTwo !== false) {
    width = nextPow2(Math.max(1, width));
    height = nextPow2(Math.max(1, height));
  }

  return { width, height, padding, extrusion, rects };
}
