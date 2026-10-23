import { useMemo, useState } from "react";
import type { PerformanceProfile, PerformanceScriptEntry } from "@haptic/debugger";
import { PropertySectionTitle, SearchInput, SelectableText, ToolbarStrip } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { cn } from "@haptic/ui/lib/utils";
import { formatRecorded as format } from "../lib/performance-timeline-model";
import { scriptCosts, type ScriptCost } from "../lib/script-cost-model";

const TH = "sticky top-0 z-10 h-7 border-b bg-panel-header px-2 font-medium whitespace-nowrap text-muted-foreground";
const TD = "px-2 text-right font-mono text-[11px] tabular-nums";
const COLUMNS: ReadonlyArray<readonly [label: string, help: string]> = [
  ["Calls", "How many times it ran while recording"],
  ["Total", "Its time over the whole recording, not counting the functions and events it called"],
  ["Per Tick", "Total divided by the recorded ticks: its average share of a tick"],
  ["Worst Tick", "The most time it took in a single tick"],
  ["Share", "Its part of all the time scripts ran while recording"],
];

function CostCells({ cost, share }: { cost: ScriptCost; share: number }) {
  return <>
    <td className={cn(TD, "text-muted-foreground")}>{cost.calls}</td>
    <td className={TD}>{format(cost.totalMs)}</td>
    <td className={TD}>{format(cost.perTickMs)}</td>
    <td className={TD}>{format(cost.worstTickMs)}</td>
    <td className="px-2">
      <div className="flex items-center gap-2">
        <div className="relative h-2 min-w-12 flex-1 bg-muted" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 bg-trace-script" style={{ width: `${Math.min(100, share * 100)}%` }} />
        </div>
        <span className="w-12 text-right font-mono text-[11px] tabular-nums">{(share * 100).toFixed(1)}%</span>
      </div>
    </td>
  </>;
}

/**
 * The Profiler's Scripts view: each Class's events and functions with how often they ran and for how
 * long, slowest first. Choosing an entry opens its graph at the entry node.
 */
export function PerformanceScripts({ profile, onOpen }: {
  profile: PerformanceProfile;
  onOpen: (entry: PerformanceScriptEntry & { graphId: string; nodeId: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const classes = useMemo(() => scriptCosts(profile), [profile]);
  const allMs = classes.reduce((sum, row) => sum + row.totalMs, 0);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return classes;
    return classes.flatMap((row) => {
      if (row.label.toLowerCase().includes(needle)) return [row];
      const entries = row.entries.filter((entry) => entry.label.toLowerCase().includes(needle));
      return entries.length ? [{ ...row, entries }] : [];
    });
  }, [classes, query]);
  if (profile.version < 4) return <Empty>
    <EmptyHeader>
      <EmptyTitle>No Script Costs</EmptyTitle>
      <EmptyDescription>This recording was made before the Profiler measured scripts. Record again to see them.</EmptyDescription>
    </EmptyHeader>
  </Empty>;
  if (!classes.length) return <Empty>
    <EmptyHeader>
      <EmptyTitle>No Scripts Ran</EmptyTitle>
      <EmptyDescription>No event, function or transition rule ran while recording.</EmptyDescription>
    </EmptyHeader>
  </Empty>;
  return <div className="flex flex-col" data-testid="profile-scripts">
    <PropertySectionTitle aside={<span className="font-normal text-muted-foreground"><SelectableText>
      {format(allMs)} ms of scripts over {profile.ticks.count} ticks · {profile.scriptEntries.length} {profile.scriptEntries.length === 1 ? "entry" : "entries"}
    </SelectableText></span>}>Scripts</PropertySectionTitle>
    <ToolbarStrip className="py-0.5">
      <SearchInput value={query} onChange={setQuery} placeholder="Search Classes, events and functions" aria-label="Search Classes, events and functions" />
    </ToolbarStrip>
    <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-xs">
      <caption className="caption-bottom px-2 py-1.5 text-left text-xs text-muted-foreground">Durations in milliseconds.</caption>
      <thead><tr>
        <th className={TH}>Class and Entry</th>
        {COLUMNS.map(([label, help]) => <th key={label} title={help} className={cn(TH, label === "Share" ? "w-[18%]" : "text-right")}>{label}</th>)}
      </tr></thead>
      {shown.map((row) => <tbody key={row.key}>
        <tr className="h-7 border-b bg-panel-header/60" data-testid="profile-script-class">
          <th className="px-2 font-medium whitespace-nowrap">{row.label}</th>
          <CostCells cost={row} share={allMs ? row.totalMs / allMs : 0} />
        </tr>
        {row.entries.map((cost) => {
          const { entry } = cost;
          const location = entry.graphId && entry.nodeId ? { ...entry, graphId: entry.graphId, nodeId: entry.nodeId } : null;
          return <tr key={cost.key} className="h-7 even:bg-list-stripe hover:bg-accent/50" data-testid="profile-script-entry">
            <th className="pl-4 font-normal whitespace-nowrap">
              {location
                ? <Button variant="ghost" size="xs" className="h-6 max-w-72 justify-start truncate px-2 font-normal pointer-coarse:min-h-11"
                  title={`Open ${cost.label} in ${row.label}`} onClick={() => onOpen(location)}>{cost.label}</Button>
                : <span className="block max-w-72 truncate px-2">{cost.label}</span>}
            </th>
            <CostCells cost={cost} share={allMs ? cost.totalMs / allMs : 0} />
          </tr>;
        })}
      </tbody>)}
    </table></div>
    {shown.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing matches the search.</p> : null}
    <PropertySectionTitle>Notes</PropertySectionTitle>
    <div className="flex flex-col gap-1 px-2 py-1.5 text-xs text-muted-foreground">
      <p>Each row counts its own time: the functions and events it calls have their own rows, so a Class's entries add up to its row. A latent event or function is timed until its first wait. Something that runs between ticks counts toward the next tick.</p>
      <p>Times come from the browser's clock, whose resolution can be coarser than a single short call. Totals over many calls are reliable; the time of one very short call is not.</p>
    </div>
  </div>;
}
