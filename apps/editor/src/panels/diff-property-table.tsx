import type { PropertyDiffGroup, PropertyDiffRow } from "@haptic/assets/asset-diff";
import { cn } from "@haptic/ui/lib/utils";
import { StatusBadge } from "./diff-common";

export type DiffLayout = "side-by-side" | "inline";

function Cell({ value, color, tone, testId }: { value: string | null; color?: string; tone?: "base" | "compare"; testId?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 px-2 py-1",
        tone === "base" && "bg-destructive/10 text-destructive",
        tone === "compare" && "bg-(--success)/15 text-(--success)",
        value === null && "text-muted-foreground",
      )}
      data-testid={testId}
    >
      {color ? <span className="size-3 shrink-0 rounded-sm border border-border" style={{ background: color }} aria-hidden="true" /> : null}
      <span className="truncate" title={value ?? undefined}>{value ?? "—"}</span>
    </div>
  );
}

function InlineCell({ row }: { row: PropertyDiffRow }) {
  if (!row.changed) return <Cell value={row.compare} {...(row.compareColor ? { color: row.compareColor } : {})} />;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 px-2 py-1">
      {row.base !== null ? <del className="truncate text-destructive" title={row.base}>{row.base}</del> : null}
      {row.compare !== null ? <span className="truncate text-(--success)" title={row.compare}>{row.compare}</span> : null}
    </div>
  );
}

/**
 * Properties grouped by component: Property, Base and the compare version
 * side by side (changed cells tinted, base destructive and compare success),
 * or Inline (the old value struck through beside the new).
 */
export function PropertyDiffTable({ groups, layout, changedOnly, baseLabel, compareLabel }: {
  groups: readonly PropertyDiffGroup[];
  layout: DiffLayout;
  changedOnly: boolean;
  baseLabel: string;
  compareLabel: string;
}) {
  const columns = layout === "side-by-side" ? "grid-cols-[minmax(7rem,0.8fr)_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[minmax(7rem,0.8fr)_minmax(0,2fr)]";
  const shown = groups
    .map((group) => ({ ...group, rows: changedOnly ? group.rows.filter((row) => row.changed) : group.rows }))
    .filter((group) => group.rows.length > 0);
  if (shown.length === 0) return <p className="p-2 text-sm text-muted-foreground" data-testid="diff-no-rows">No Changed Properties.</p>;
  return (
    <div className="flex flex-col text-sm" role="table" aria-label="Properties" data-testid="diff-properties">
      <div className={cn("grid border-b border-border text-xs font-semibold text-muted-foreground", columns)} role="row">
        <div className="px-2 py-1" role="columnheader">Property</div>
        {layout === "side-by-side" ? (
          <>
            <div className="truncate px-2 py-1" role="columnheader">Base ({baseLabel})</div>
            <div className="truncate px-2 py-1" role="columnheader">{compareLabel}</div>
          </>
        ) : <div className="truncate px-2 py-1" role="columnheader">{baseLabel} → {compareLabel}</div>}
      </div>
      {shown.map((group) => (
        <div key={group.id} role="rowgroup" data-group-id={group.id} data-testid={`diff-group-${group.id || "fields"}`}>
          <div className="flex h-[var(--chrome-row,28px)] items-center gap-2 bg-panel-header px-2 text-xs font-semibold" role="row">
            <span className="truncate" role="rowheader">{group.title}</span>
            <StatusBadge status={group.status} />
          </div>
          {group.rows.map((row) => (
            <div key={row.id} className={cn("grid border-b border-border/50", columns)} role="row" data-changed={row.changed || undefined} data-testid={`diff-row-${row.id}`}>
              <div className="truncate px-2 py-1 text-muted-foreground" role="cell" title={row.label}>{row.label}</div>
              {layout === "side-by-side" ? (
                <>
                  <Cell value={row.base} {...(row.baseColor ? { color: row.baseColor } : {})} {...(row.changed ? { tone: "base" as const } : {})} />
                  <Cell value={row.compare} {...(row.compareColor ? { color: row.compareColor } : {})} {...(row.changed ? { tone: "compare" as const } : {})} />
                </>
              ) : <InlineCell row={row} />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
