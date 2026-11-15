import type { AnimEventFlash } from "../lib/anim-event-flashes";

/** Fired event names over a Preview's view, newest last. */
export function AnimEventFlashes({ flashes, "data-testid": testId }: { flashes: readonly AnimEventFlash[]; "data-testid"?: string }) {
  if (flashes.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-2 top-2 flex flex-col items-start gap-1" data-testid={testId}>
      {flashes.map((entry) => (
        <span
          key={entry.id}
          className="rounded-sm bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground shadow-sm"
          data-testid={testId ? `${testId}-name` : undefined}
        >
          {entry.label}
        </span>
      ))}
    </div>
  );
}

