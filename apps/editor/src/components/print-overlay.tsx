import { useMemo, useState } from "react";

export type PrintOverlayEntry = {
  key: string;
  message: string;
  color: string;
  expiresAt: number;
};

export type PrintOverlayProps = {
  entries: PrintOverlayEntry[];
};

/** Keyed on-screen prints (P5). Entries with the same key replace in place. */
export function PrintOverlay({ entries }: PrintOverlayProps) {
  const visible = useMemo(
    () => entries.filter((e) => e.expiresAt > Date.now()),
    [entries],
  );
  if (visible.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-12 z-40 flex flex-col items-center gap-1 px-4"
      data-testid="print-overlay"
    >
      {visible.map((e) => (
        <div
          key={e.key}
          className="rounded-md bg-black/60 px-3 py-1 text-sm"
          style={{ color: e.color }}
        >
          {e.message}
        </div>
      ))}
    </div>
  );
}

export function usePrintRegistry() {
  const [entries, setEntries] = useState<PrintOverlayEntry[]>([]);

  const print = (options: {
    message: string;
    key?: string;
    duration?: number;
    color?: string;
  }) => {
    const key = options.key?.trim() || `print_${Date.now()}_${Math.random()}`;
    const duration = (options.duration ?? 2) * 1000;
    const color = options.color ?? "#ffffff";
    setEntries((prev) => {
      const next = prev.filter((e) => e.key !== key);
      next.push({
        key,
        message: options.message,
        color,
        expiresAt: Date.now() + duration,
      });
      return next;
    });
  };

  return { entries, print, setEntries };
}
