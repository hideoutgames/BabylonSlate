import {
  applyPrintHudCommand,
  nextPrintHudTimeoutMs,
  visiblePrintHudEntries,
  type PrintHudColor,
  type PrintHudEntry,
} from "@babylonslate/core";

function asPrintColor(value: unknown): PrintHudColor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    x: Number(record.x) || 0,
    y: Number(record.y) || 0,
    z: Number(record.z) || 0,
    w: Number(record.w) || 0,
  };
}

function visibleSignature(entries: readonly PrintHudEntry[], now: number): string {
  return visiblePrintHudEntries(entries, now)
    .map((entry) => `${entry.key}\n${entry.message}\n${entry.color}`)
    .join("\n---\n");
}

export function mountPlayerPrintOverlay(parent: HTMLElement): {
  applyPrint: (command: {
    message?: unknown;
    key?: unknown;
    duration?: unknown;
    color?: unknown;
  }) => void;
  dispose: () => void;
} {
  const host = document.createElement("div");
  host.dataset.testid = "print-overlay";
  host.style.cssText =
    "position:fixed;inset:3rem 0 auto 0;z-index:40;display:flex;flex-direction:column;align-items:center;gap:4px;padding:0 1rem;pointer-events:none;";
  parent.appendChild(host);

  let entries: PrintHudEntry[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let renderedSignature = "";

  const render = () => {
    const now = Date.now();
    const visible = visiblePrintHudEntries(entries, now);
    const signature = visibleSignature(entries, now);
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      host.replaceChildren();
      for (const entry of visible) {
        const row = document.createElement("div");
        row.style.cssText =
          "border-radius:6px;background:rgba(0,0,0,0.6);padding:4px 12px;font:14px/1.4 ui-sans-serif,system-ui,sans-serif;";
        row.style.color = entry.color;
        row.textContent = entry.message;
        host.appendChild(row);
      }
      host.hidden = visible.length === 0;
    }
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    const delay = nextPrintHudTimeoutMs(entries, now);
    if (delay !== null) {
      timeout = setTimeout(render, delay);
    }
  };

  return {
    applyPrint: (command) => {
      entries = applyPrintHudCommand(entries, {
        message: String(command.message ?? ""),
        key: typeof command.key === "string" ? command.key : "",
        duration:
          typeof command.duration === "number" ? command.duration : undefined,
        color: asPrintColor(command.color),
      });
      render();
    },
    dispose: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      host.remove();
    },
  };
}
