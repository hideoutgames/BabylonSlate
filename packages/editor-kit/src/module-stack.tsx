import { useId, type CSSProperties, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Switch } from "@babylonslate/ui/components/switch";
import { nodeRoleColorVar, type NodeRole } from "@babylonslate/ui/lib/data-types";
import { cn } from "@babylonslate/ui/lib/utils";

export interface ModuleStackProps {
  children: ReactNode;
  "data-testid"?: string;
}

/** Vertical list of ModuleStages (Basic Particle Emitter Details). */
export function ModuleStack({ children, "data-testid": testId }: ModuleStackProps) {
  return (
    <div className="flex flex-col gap-2 pb-2" data-testid={testId}>
      {children}
    </div>
  );
}

export interface ModuleStageProps {
  id: string;
  /** Title Case stage name, e.g. "Over Life". */
  title: string;
  /** Node role whose `--node-*` token accents the stage and its cards. */
  accentRole: NodeRole;
  /** ModuleCards. */
  children: ReactNode;
}

/** Stage section with a sticky header; the accent is a `var(--node-*)` reference. */
export function ModuleStage({ id, title, accentRole, children }: ModuleStageProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      style={{ "--module-accent": nodeRoleColorVar(accentRole) } as CSSProperties}
      data-testid={`module-stage-${id}`}
    >
      {/* z-20 keeps expanded curve keys (z-10 inside an isolated plot) under the header. */}
      <h3
        id={headingId}
        className="sticky top-0 z-20 flex min-h-[var(--chrome-row,28px)] items-center gap-1.5 bg-sidebar px-2 text-xs font-semibold text-muted-foreground"
      >
        <span
          aria-hidden="true"
          className="h-3 w-[3px] shrink-0 rounded-full bg-[var(--module-accent)]"
        />
        {title}
      </h3>
      <div className="flex flex-col gap-1 px-2">{children}</div>
    </section>
  );
}

export interface ModuleCardProps {
  id: string;
  /** Title Case module name, e.g. "Spawn Rate". */
  title: string;
  /** UI state, host-owned like DisclosureSection. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit both for always-on modules: no switch is rendered. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  /** Muted trailing text while collapsed, e.g. "30 /s". */
  summary?: string;
  summaryTone?: "muted" | "destructive";
  /** Usually a PropertyGrid. */
  children: ReactNode;
  /** Defaults to `module-card-<id>`. */
  "data-testid"?: string;
}

/**
 * Collapsible module card with an optional enable Switch. Disabled modules
 * collapse and render no body; hosts keep their data so re-enabling restores it.
 */
export function ModuleCard({
  id,
  title,
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
  summary,
  summaryTone = "muted",
  children,
  "data-testid": testId,
}: ModuleCardProps) {
  const rootId = testId ?? `module-card-${id}`;
  const bodyId = useId();
  const toggleable = enabled !== undefined;
  const off = enabled === false;
  const expanded = open && !off;

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-border/60 bg-sidebar"
      data-enabled={toggleable ? String(!off) : undefined}
      data-testid={rootId}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-0.5 bg-[var(--module-accent)]",
          off && "opacity-40",
        )}
      />
      <div
        className={cn(
          "flex min-h-[var(--chrome-row,28px)] items-center gap-1 bg-panel-header px-1 pointer-coarse:min-h-[var(--touch-target)]",
          expanded && "border-b border-border/60",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start px-1 disabled:opacity-100 pointer-coarse:min-h-11"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          disabled={off}
          onClick={() => onOpenChange(!open)}
          data-testid={`${rootId}-toggle`}
        >
          <ChevronDownIcon
            data-icon="inline-start"
            aria-hidden="true"
            className={expanded ? undefined : "-rotate-90"}
          />
          <span className={cn("truncate", off && "text-muted-foreground")}>{title}</span>
        </Button>
        {!expanded && !off && summary ? (
          <span
            className={cn(
              "min-w-0 max-w-[45%] truncate text-xs tabular-nums",
              summaryTone === "destructive" ? "text-destructive" : "text-muted-foreground",
            )}
            data-testid={`${rootId}-summary`}
          >
            {summary}
          </span>
        ) : null}
        {toggleable ? (
          <Switch
            size="sm"
            className="mr-1 pointer-coarse:after:-inset-y-[15px]"
            checked={!off}
            aria-label={`${title} Enabled`}
            onCheckedChange={(checked) => onEnabledChange?.(checked)}
            data-testid={`${rootId}-enabled`}
          />
        ) : null}
      </div>
      {expanded ? (
        <div id={bodyId} data-testid={`${rootId}-body`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
