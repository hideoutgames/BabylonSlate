import type { PropertyRow } from "@babylonslate/editor-kit";

type PathPropertyRowsOptions = {
  idPrefix: string;
  points: [number, number, number][];
  curvature: number;
  curvatureDescription: string;
  pointsDescription: string;
  minPoints?: 2 | 3;
  extraPointRows?: (index: number) => PropertyRow[];
  update: (property: string, value: unknown) => void;
};

/** Shared local-space path controls for splines and water rivers. */
export function pathPropertyRows({
  idPrefix,
  points,
  curvature,
  curvatureDescription,
  pointsDescription,
  minPoints = 2,
  extraPointRows,
  update,
}: PathPropertyRowsOptions): PropertyRow[] {
  return [
    {
      kind: "number",
      id: `${idPrefix}-curvature`,
      label: "Curvature",
      value: curvature,
      defaultValue: 1,
      min: 0,
      max: 1,
      description: curvatureDescription,
      onChange: (value) => update("curvature", value),
    },
    {
      kind: "number",
      id: `${idPrefix}-pointCount`,
      label: "Path Point Count",
      value: points.length,
      min: minPoints,
      max: 128,
      description: pointsDescription,
      onChange: (count) => {
        if (!Number.isFinite(count)) return;
        const length = Math.max(minPoints, Math.min(128, Math.round(count)));
        const next = points.slice(0, length);
        while (next.length < length) {
          const last = next[next.length - 1]!;
          next.push([last[0], last[1], last[2] + 5]);
        }
        update("points", next);
      },
    },
    ...points.flatMap((point, index): PropertyRow[] => [
      {
        kind: "vector3",
        id: `${idPrefix}-point-${index}`,
        label: `Path Point ${index + 1}`,
        value: point,
        onChange: (value) => update(
          "points",
          points.map((current, i) => i === index ? value.slice(0, 3) : current),
        ),
      },
      ...(extraPointRows?.(index) ?? []),
    ]),
  ];
}
