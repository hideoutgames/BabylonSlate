import { cn } from "@babylonslate/ui/lib/utils";
import type { PinDefaultPreview } from "./pin-default-preview";

const STRING_FIELD_CLASS =
  "pointer-events-none h-8 max-w-[var(--graph-pin-default-max-width,12rem)] shrink-0 truncate rounded-sm border border-input bg-input/30 px-1.5 text-base leading-8 text-foreground select-none";

const GROW_FIELD_CLASS =
  "pointer-events-none h-8 shrink-0 whitespace-nowrap rounded-sm border border-input bg-input/30 px-1.5 text-base leading-8 text-foreground select-none";

function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" className="size-3.5" aria-hidden="true">
      <path
        d="M2.5 6.2 4.8 8.5 9.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PinDefaultPreviewWidget({
  preview,
}: {
  preview: PinDefaultPreview;
}) {
  if (preview.kind === "bool") {
    return (
      <span
        data-pin-default="bool"
        data-checked={preview.checked ? "true" : "false"}
        className={cn(
          "pointer-events-none inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-input select-none",
          preview.checked &&
            "border-primary bg-primary text-primary-foreground",
        )}
        aria-hidden="true"
      >
        {preview.checked ? <CheckMark /> : null}
      </span>
    );
  }

  if (preview.kind === "color") {
    return (
      <span
        data-pin-default="color"
        className="pointer-events-none size-5 shrink-0 rounded-sm border border-input"
        style={{ background: preview.rgb }}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      data-pin-default={preview.kind}
      className={preview.kind === "string" ? STRING_FIELD_CLASS : GROW_FIELD_CLASS}
      aria-hidden="true"
    >
      {preview.text}
    </span>
  );
}
