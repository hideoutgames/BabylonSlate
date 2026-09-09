import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { IconActionButton } from "./icon-action-button";

/** Full selected message beneath compact, windowed diagnostics and logs. */
export function MessageDetails({
  title,
  message,
  onClose,
}: {
  title: string;
  message: string;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const copyAttempt = useRef(0);
  useEffect(() => {
    setFeedback("");
    return () => {
      copyAttempt.current += 1;
    };
  }, [message]);
  const copy = async () => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(message);
      if (attempt === copyAttempt.current) setFeedback("Copied");
    } catch {
      if (attempt === copyAttempt.current)
        setFeedback("Copy failed. Select the text below to copy it manually.");
    }
  };
  return (
    <section
      aria-label={title}
      className="flex max-h-[45%] min-h-20 shrink-0 flex-col gap-1 border-t border-border p-2"
    >
      <div className="flex shrink-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 text-xs font-medium">{title}</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
        >
          Copy
        </Button>
        <IconActionButton
          label="Close Details"
          size="icon-sm"
          onClick={onClose}
        >
          <XIcon />
        </IconActionButton>
      </div>
      {feedback ? (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      ) : null}
      <div className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words text-xs">
        <SelectableText>{message}</SelectableText>
      </div>
    </section>
  );
}
