import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
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

/** Play/export console: history, registry autocomplete, SelectableText transcript. */
export function DebugConsole({
  open,
  onOpenChange,
  commands,
  onExecute,
}: DebugConsoleProps) {
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const suggestions = useMemo(
    () => suggestConsoleCompletions(draft, commands),
    [draft, commands],
  );

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(32rem,80vh)] w-full flex-col gap-3 overflow-hidden sm:max-w-lg"
        data-testid="debug-console"
      >
        <DialogHeader>
          <DialogTitle>Console</DialogTitle>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div
            className="flex flex-col gap-1 p-2 font-mono text-xs"
            data-testid="debug-console-transcript"
          >
            {entries.map((entry, index) => (
              <div key={`${index}-${entry.line}`}>
                <SelectableText>{`> ${entry.line}`}</SelectableText>
                {entry.output ? (
                  <div data-testid={`debug-console-output-${index}`}>
                    <SelectableText>{entry.output}</SelectableText>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
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
      </DialogContent>
    </Dialog>
  );
}
