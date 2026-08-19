import { useEffect, useMemo, useState } from "react";
import {
  applyPrintHudCommand,
  nextPrintHudTimeoutMs,
  visiblePrintHudEntries,
  type PrintHudColor,
  type PrintHudEntry,
} from "@babylonslate/core";

export type PrintOverlayEntry = PrintHudEntry;

export type PrintOverlayProps = {
  entries: PrintOverlayEntry[];
};

/** Keyed on-screen prints (P5). Entries with the same key replace in place. */
export function PrintOverlay({ entries }: PrintOverlayProps) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const delay = nextPrintHudTimeoutMs(entries);
    if (delay === null) return;
    const id = window.setTimeout(() => setClock((tick) => tick + 1), delay);
    return () => window.clearTimeout(id);
  }, [entries, clock]);
  const visible = useMemo(
    () => visiblePrintHudEntries(entries),
    [entries, clock],
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
    color?: string | PrintHudColor;
  }) => {
    const color =
      typeof options.color === "string"
        ? parseCssColor(options.color)
        : options.color;
    setEntries((prev) =>
      applyPrintHudCommand(prev, {
        message: options.message,
        key: options.key,
        duration: options.duration,
        color,
      }),
    );
  };

  return { entries, print, setEntries };
}

function parseCssColor(color: string): PrintHudColor | undefined {
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(
    color,
  );
  if (rgba) {
    return {
      x: Number(rgba[1]) / 255,
      y: Number(rgba[2]) / 255,
      z: Number(rgba[3]) / 255,
      w: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (!hex) return undefined;
  const n = Number.parseInt(hex[1]!, 16);
  return {
    x: ((n >> 16) & 255) / 255,
    y: ((n >> 8) & 255) / 255,
    z: (n & 255) / 255,
    w: 1,
  };
}
