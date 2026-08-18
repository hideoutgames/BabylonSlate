import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  suggestConsoleCompletions,
  type RegisteredCommand,
} from "@babylonslate/debugger";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Input } from "@babylonslate/ui/components/input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { cn } from "@babylonslate/ui/lib/utils";

export type ConsoleExecuteResult = {
  success: boolean;
  output: string;
};

export type DebugConsoleProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly RegisteredCommand[];
  onExecute: (
    line: string,
  ) => ConsoleExecuteResult | Promise<ConsoleExecuteResult>;
};

const ACCESSORY = ["\"", "'", "=", ":", ",", ".", "/", "-", "Tab"] as const;

type HistoryEntry = {
  line: string;
  success: boolean;
  output: string;
};

function formatTranscript(entries: readonly HistoryEntry[]): string {
  return entries
    .map((entry) =>
      entry.output ? `> ${entry.line}\n${entry.output}` : `> ${entry.line}`,
    )
    .join("\n");
}

/** Play overlay console: large transcript, history, registry autocomplete. */
export function DebugConsole({
  open,
  onOpenChange,
  commands,
  onExecute,
}: DebugConsoleProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const suggestions = useMemo(
    () => suggestConsoleCompletions(draft, commands),
    [draft, commands],
  );

  useEffect(() => {
    const end = transcriptEndRef.current;
    if (typeof end?.scrollIntoView === "function") {
      end.scrollIntoView({ block: "end" });
    }
  }, [entries]);

  const submit = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const result = await onExecute(trimmed);
    setEntries((prev) => [
      ...prev,
      { line: trimmed, success: result.success, output: result.output },
    ]);
    setDraft("");
    setHistoryIndex(null);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" && entries.length > 0) {
      event.preventDefault();
      const next =
        historyIndex === null
          ? entries.length - 1
          : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setDraft(entries[next]?.line ?? draft);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      if (historyIndex >= entries.length - 1) {
        setHistoryIndex(null);
        setDraft("");
        return;
      }
      const next = historyIndex + 1;
      setHistoryIndex(next);
      setDraft(entries[next]?.line ?? "");
    }
  };

  const insert = (token: string) => {
    setDraft((current) =>
      token === "Tab" ? `${current}${suggestions[0] ?? "  "}` : `${current}${token}`,
    );
  };

  const copyTranscript = async () => {
    await navigator.clipboard.writeText(formatTranscript(entries));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(92vh,56rem)] w-[min(96vw,80rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        data-testid="debug-console"
        initialFocus={bodyRef}
      >
        <DialogHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-3 pr-14">
          <DialogTitle>Console</DialogTitle>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="touch"
              variant="outline"
              data-testid="debug-console-clear"
              onClick={() => setEntries([])}
            >
              Clear
            </Button>
            <Button
              type="button"
              size="touch"
              variant="outline"
              data-testid="debug-console-copy"
              onClick={() => void copyTranscript()}
            >
              Copy Transcript
            </Button>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1 bg-background">
          <div
            ref={bodyRef}
            tabIndex={-1}
            className="flex min-h-full flex-col gap-1 p-3 font-mono text-sm outline-none"
            data-testid="debug-console-transcript"
          >
            {entries.map((entry, index) => (
              <div key={`${index}-${entry.line}`}>
                <SelectableText>{`> ${entry.line}`}</SelectableText>
                {entry.output ? (
                  <div
                    className={cn(
                      entry.success ? "text-foreground" : "text-destructive",
                    )}
                    data-testid={`debug-console-output-${index}`}
                  >
                    <SelectableText>{entry.output}</SelectableText>
                  </div>
                ) : null}
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </ScrollArea>
        <div className="flex shrink-0 flex-col gap-2 border-t p-3">
          {suggestions.length > 0 ? (
            <div
              className="flex flex-wrap gap-1"
              data-testid="debug-console-suggestions"
            >
              {suggestions.slice(0, 8).map((name) => (
                <Button
                  key={name}
                  type="button"
                  variant="outline"
                  size="touch"
                  data-testid={`debug-console-suggest-${name}`}
                  onClick={() => setDraft(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          ) : null}
          <form className="flex gap-2" onSubmit={onSubmit}>
            <Input
              className="min-h-11 flex-1 font-mono"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="changescene …"
              aria-label="Console command"
              data-testid="debug-console-input"
              autoComplete="off"
              autoCorrect="off"
              autoFocus={false}
            />
            <Button type="submit" size="touch" data-testid="debug-console-submit">
              Run
            </Button>
          </form>
          <div
            className="flex flex-wrap gap-1"
            data-testid="debug-console-accessory"
          >
            {ACCESSORY.map((token) => (
              <Button
                key={token}
                type="button"
                variant="secondary"
                size="touch-icon"
                aria-label={token === "Tab" ? "Tab" : `Insert ${token}`}
                onClick={() => insert(token)}
              >
                {token === "Tab" ? "⇥" : token}
              </Button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
