import { useState } from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { usePlatformLayoutOptions } from "../shell/use-platform-layout";

export function useTraceTouch() {
  return usePlatformLayoutOptions().dndStrategy === "pointer";
}

export function TraceEmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}

export function TraceCopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const touch = useTraceTouch();
  const [result, setResult] = useState<{
    text: string;
    message: string;
  } | null>(null);
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size={touch ? "touch" : "sm"}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setResult({ text, message: "Copied" }),
            () =>
              setResult({ text, message: "Copy Failed — Select Text To Copy" }),
          );
          if (!navigator.clipboard)
            setResult({ text, message: "Select Text To Copy" });
        }}
      >
        {label}
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {result?.text === text ? result.message : ""}
      </span>
    </div>
  );
}
