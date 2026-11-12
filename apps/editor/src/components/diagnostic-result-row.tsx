import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ArrowUpRightIcon,
  CircleXIcon,
  ClipboardListIcon,
  CopyIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ContextMenuOverlay,
  doubleTapWindowMs,
  SelectableText,
  useContextMenu,
  type ContextMenuItem,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { copyText } from "../lib/diagnostic-info";

const SEVERITY = {
  error: { label: "Error", copyLabel: "Copy Error", tone: "text-destructive" },
  warning: { label: "Warning", copyLabel: "Copy Warning", tone: "text-(--warning)" },
  info: { label: "Info", copyLabel: "Copy Message", tone: "text-muted-foreground" },
} as const;

/** How long a failed copy replaces the code and location line. */
const COPY_NOTICE_MS = 4000;

/**
 * The icon is chosen while rendering. Storing `TriangleAlertIcon` on a
 * module-scope object copies it before a chunk cycle finishes initializing
 * that export, so production renders an undefined component.
 */
function SeverityIcon({
  severity,
  className,
}: {
  severity: keyof typeof SEVERITY;
  className: string;
}) {
  if (severity === "error") return <CircleXIcon aria-hidden="true" className={className} />;
  if (severity === "warning") return <TriangleAlertIcon aria-hidden="true" className={className} />;
  return <InfoIcon aria-hidden="true" className={className} />;
}

/** The row's full text when its host gives no `details`: severity and code, message, location. */
export function diagnosticRowDetails({
  severity,
  message,
  code,
  location,
}: {
  severity: keyof typeof SEVERITY;
  message: string;
  code?: string;
  location?: string;
}): string {
  return [code ? `${severity}: ${code}` : severity, message, location]
    .filter(Boolean)
    .join("\n");
}

/** Diagnostic Details for a graph asset's own checks: severity and code, message, node. */
export function nodeDiagnosticDetails(diagnostic: {
  severity: string;
  code: string;
  message: string;
  nodeId?: string;
}): string {
  return `${diagnostic.severity}: ${diagnostic.code}\n${diagnostic.message}${diagnostic.nodeId ? `\nNode: ${diagnostic.nodeId}` : ""}`;
}

/**
 * One 44px diagnostic row (Compiler Results, Preview Session Report, Data Tree
 * validation): a ghost button with a severity icon, the truncated message, and
 * an optional mono code / location line. A click or tap chooses it; a
 * double-click or double-tap opens its location. Right-click or a long-press
 * opens its menu: **Open**, **Copy Error** / **Copy Warning** (the message) and
 * **Copy Details**.
 */
export function DiagnosticResultRow({
  severity,
  message,
  code,
  location,
  selected = false,
  onSelect,
  onOpen,
  details,
  testId,
  nodeId,
}: {
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  /** Node or pin the diagnostic points at. */
  location?: string;
  selected?: boolean;
  onSelect: () => void;
  /**
   * Goes to the location: a double-click or double-tap, and the menu's
   * **Open**. Without it a second click chooses the row again.
   */
  onOpen?: () => void;
  /** Text for **Copy Details**, as the host's Diagnostic Details shows it. */
  details?: string;
  /** On the row button. */
  testId: string;
  /** Node the row navigates to, exposed as `data-node-id`. */
  nodeId?: string;
}) {
  const { label, copyLabel, tone } = SEVERITY[severity];
  const lastClickAt = useRef(0);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(null), COPY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copyNotice]);

  // Text is built before the write: iPad Safari rejects one that follows an await.
  const copy = (text: string) => {
    void copyText(text).then((ok) => {
      setCopyNotice(ok ? null : "Could not copy to the clipboard.");
    });
  };
  const menu = useContextMenu({
    items: (): ContextMenuItem[] => [
      ...(onOpen
        ? [
            { id: "open", label: "Open", icon: <ArrowUpRightIcon />, testId: "diagnostic-menu-open", onSelect: onOpen },
            { type: "separator" as const, id: "open-separator" },
          ]
        : []),
      { id: "copy", label: copyLabel, icon: <CopyIcon />, testId: "diagnostic-menu-copy", onSelect: () => copy(message) },
      {
        id: "copy-details",
        label: "Copy Details",
        icon: <ClipboardListIcon />,
        testId: "diagnostic-menu-copy-details",
        onSelect: () => copy(details ?? diagnosticRowDetails({ severity, message, code, location })),
      },
    ],
  });

  const onClick = (event: MouseEvent) => {
    // Keyboard activation (detail 0) chooses; the menu key offers Open.
    const now = Date.now();
    const pointer = event.detail !== 0;
    const second = pointer && (event.detail === 2 || now - lastClickAt.current <= doubleTapWindowMs());
    lastClickAt.current = pointer && !second ? now : 0;
    if (second && onOpen) onOpen();
    else onSelect();
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className={cn(
          "h-full min-h-0 w-full min-w-0 justify-start gap-2 overflow-hidden rounded-none px-2 text-left font-normal",
          selected && "bg-accent text-accent-foreground hover:bg-accent",
        )}
        onClick={onClick}
        {...menu.bind}
        aria-pressed={selected}
        data-testid={testId}
        data-severity={severity}
        data-node-id={nodeId}
      >
        <SeverityIcon severity={severity} className={cn("size-3.5 shrink-0", tone)} />
        <span className="sr-only">{label}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <SelectableText className="truncate text-xs leading-4 text-foreground">
            {message}
          </SelectableText>
          {copyNotice ? (
            <span role="status" className="truncate text-[10px] leading-3.5 text-destructive">
              {copyNotice}
            </span>
          ) : code || location ? (
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-3.5 text-muted-foreground">
              {code ? <span className="shrink-0">{code}</span> : null}
              {code && location ? <span aria-hidden="true">·</span> : null}
              {location ? <span className="truncate">{location}</span> : null}
            </span>
          ) : null}
        </span>
      </Button>
      <ContextMenuOverlay
        menu={menu.menu}
        onClose={menu.closeMenu}
        contentTestId="diagnostic-row-menu"
      />
    </>
  );
}
