import { humanizePropertyLabel, PropertySectionTitle, SelectableText } from "@haptic/editor-kit";
import { cn } from "@haptic/ui/lib/utils";

const factValue = (value: unknown) => value == null ? "Unavailable" : typeof value === "string" ? value : JSON.stringify(value);

/** Read-only recorded values as selectable label/value rows rather than disabled inputs. */
export function Facts({ title, aside, data, columns = 1 }: { title: string; aside?: string; data: Record<string, unknown>; columns?: 1 | 3 }) {
  return <section className="flex min-w-0 flex-col" aria-label={title}>
    <PropertySectionTitle aside={aside ? <span className="font-normal text-muted-foreground">{aside}</span> : undefined}>{title}</PropertySectionTitle>
    <dl className={cn("grid text-xs", columns === 3 && "md:grid-cols-3")}>
      {Object.entries(data).map(([id, value], index) => <div key={id} className={cn("flex min-h-7 min-w-0 items-baseline gap-2 px-2 py-1", (columns === 1 ? index % 2 : Math.floor(index / 3) % 2) && "bg-list-stripe")}>
        <dt className="w-32 shrink-0 truncate text-muted-foreground">{humanizePropertyLabel(id)}</dt>
        <dd className={cn("min-w-0 flex-1 font-mono text-[11px] break-all", value == null && "font-sans text-xs text-muted-foreground")}><SelectableText>{factValue(value)}</SelectableText></dd>
      </div>)}
    </dl>
  </section>;
}
