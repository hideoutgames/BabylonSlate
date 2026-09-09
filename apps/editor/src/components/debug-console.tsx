import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  applyConsoleCompletion,
  suggestConsoleCompletions,
  type ConsoleCompletionContext,
  type RegisteredCommand,
} from "@babylonslate/debugger";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button, buttonVariants } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Separator } from "@babylonslate/ui/components/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";
import { cn } from "@babylonslate/ui/lib/utils";
import { ChevronRightIcon, TerminalIcon, XIcon } from "lucide-react";

export type ConsoleExecuteResult = { success: boolean; output: string };

/** IDs increase throughout a session, including while the console is closed. */
export type DebugConsoleLogEntry = {
  id: number;
  timestamp: number;
  severity: string;
  message: string;
};

export type DebugConsoleProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly RegisteredCommand[];
  completionContext?: ConsoleCompletionContext;
  logs?: readonly DebugConsoleLogEntry[];
  onExecute: (
    line: string,
  ) => ConsoleExecuteResult | Promise<ConsoleExecuteResult>;
};

const ACCESSORY = ['"', "'", "=", ":", ",", ".", "/", "-", "Tab"] as const;
const NO_LOGS: readonly DebugConsoleLogEntry[] = [];
const TRANSCRIPT_LIMIT = 500;

type TranscriptEntry = {
  id: string;
  timestamp: number;
  text: string;
  severity: string;
  testId?: string;
};

function commandUsage(command: RegisteredCommand): string {
  return command.parameters
    .map((parameter) => {
      const type =
        parameter.type === "bool"
          ? "on|off"
          : (parameter.enumValues?.join("|") ?? parameter.type);
      const value = `${parameter.name}: ${type}`;
      return parameter.optional || parameter.defaultValue !== undefined
        ? `[${value}]`
        : `<${value}>`;
    })
    .join(" ");
}

/** Flat console over the running view, shared by Play and Preview Build. */
export function DebugConsole({
  open,
  onOpenChange,
  commands,
  completionContext,
  logs = NO_LOGS,
  onExecute,
}: DebugConsoleProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const commandIdRef = useRef(0);
  const executingRef = useRef(false);
  const draftBeforeHistoryRef = useRef("");
  const listId = useId();
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [clearedLogId, setClearedLogId] = useState(-Infinity);
  const [executing, setExecuting] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const suggestions = useMemo(
    () =>
      draft
        ? suggestConsoleCompletions(draft, commands, completionContext)
        : [],
    [draft, commands, completionContext],
  );
  const selectedIndex = Math.min(
    activeSuggestion,
    Math.max(0, suggestions.length - 1),
  );
  const transcript = useMemo(
    () =>
      [
        ...entries,
        ...logs
          .filter((entry) => entry.id > clearedLogId)
          .map((entry): TranscriptEntry => ({
            id: `log-${entry.id}`,
            timestamp: entry.timestamp,
            text: `[${entry.severity}] ${entry.message}`,
            severity: entry.severity,
            testId: `debug-console-log-${entry.id}`,
          })),
      ]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-TRANSCRIPT_LIMIT),
    [entries, logs, clearedLogId],
  );

  useEffect(() => {
    if (open && followOutputRef.current)
      transcriptEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [transcript, open]);
  useEffect(() => {
    suggestionsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, suggestions]);

  const updateDraft = (value: string) => {
    setDraft(value);
    setHistoryIndex(null);
    setActiveSuggestion(0);
  };
  const submit = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || executingRef.current) return;
    executingRef.current = true;
    setExecuting(true);
    const id = commandIdRef.current++;
    followOutputRef.current = true;
    setEntries((previous) =>
      [
        ...previous,
        {
          id: `command-${id}`,
          timestamp: Date.now(),
          text: `> ${trimmed}`,
          severity: "command",
        },
      ].slice(-TRANSCRIPT_LIMIT),
    );
    setHistory((previous) => [...previous, trimmed].slice(-TRANSCRIPT_LIMIT));
    updateDraft("");
    try {
      let result: ConsoleExecuteResult;
      try {
        result = await onExecute(trimmed);
      } catch (error) {
        result = {
          success: false,
          output: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.output)
        setEntries((previous) =>
          [
            ...previous,
            {
              id: `result-${id}`,
              timestamp: Date.now(),
              text: result.output,
              severity: result.success ? "result" : "error",
              testId: `debug-console-output-${id}`,
            },
          ].slice(-TRANSCRIPT_LIMIT),
        );
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(draft);
  };
  const applySuggestion = (suggestion: string) => {
    updateDraft(applyConsoleCompletion(draft, suggestion, commands));
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && suggestions[selectedIndex]) {
      event.preventDefault();
      applySuggestion(suggestions[selectedIndex]!);
      return;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      historyIndex === null &&
      suggestions.length > 0
    ) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveSuggestion(
        (selectedIndex + direction + suggestions.length) % suggestions.length,
      );
      return;
    }
    if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      if (historyIndex === null) draftBeforeHistoryRef.current = draft;
      const next =
        historyIndex === null
          ? history.length - 1
          : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setDraft(history[next] ?? "");
    } else if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setDraft(draftBeforeHistoryRef.current);
      } else {
        setHistoryIndex(next);
        setDraft(history[next] ?? "");
      }
    }
  };
  const insert = (token: string) => {
    if (token === "Tab") {
      if (suggestions[selectedIndex])
        applySuggestion(suggestions[selectedIndex]!);
    } else {
      updateDraft(`${draft}${token}`);
      inputRef.current?.focus();
    }
  };
  const clearTranscript = () => {
    setEntries([]);
    setClearedLogId((previous) =>
      Math.max(previous, ...logs.map((entry) => entry.id)),
    );
    setCopyStatus("");
  };
  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(
        transcript.map((entry) => entry.text).join("\n"),
      );
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy Failed");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="w-full gap-0 overflow-hidden rounded-none shadow-none data-[side=bottom]:h-[min(58dvh,38rem)]"
        data-testid="debug-console"
        initialFocus={(interaction) =>
          interaction === "keyboard" ? inputRef.current : bodyRef.current
        }
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 px-2 py-1 pr-2">
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
            <SheetTitle>Console</SheetTitle>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="pointer-coarse:min-h-11"
              data-testid="debug-console-clear"
              onClick={clearTranscript}
            >
              Clear
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="pointer-coarse:min-h-11"
              data-testid="debug-console-copy"
              onClick={() => void copyTranscript()}
            >
              {copyStatus || "Copy Transcript"}
            </Button>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  aria-label="Close"
                />
              }
            >
              <XIcon />
            </SheetClose>
          </div>
        </SheetHeader>
        <Separator />
        <ScrollArea
          className="min-h-0 flex-1 bg-background"
          onScroll={(event) => {
            const viewport = event.target as HTMLElement;
            followOutputRef.current =
              viewport.scrollHeight -
                viewport.scrollTop -
                viewport.clientHeight <
              48;
          }}
        >
          <div
            ref={bodyRef}
            tabIndex={-1}
            className="flex min-h-full flex-col gap-0.5 px-3 py-2 font-mono text-xs outline-none"
            data-testid="debug-console-transcript"
            role="log"
            aria-label="Play Console Output"
            aria-live="polite"
          >
            {transcript.map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  entry.severity === "error"
                    ? "text-destructive"
                    : entry.severity === "info"
                      ? "text-muted-foreground"
                      : "text-foreground",
                  (entry.severity === "warning" || entry.severity === "warn") &&
                    "font-semibold",
                )}
                data-testid={entry.testId}
                data-severity={entry.severity}
              >
                <SelectableText>{entry.text}</SelectableText>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </ScrollArea>
        {suggestions.length > 0 ? (
          <>
            <Separator />
            <div
              ref={suggestionsRef}
              id={listId}
              role="listbox"
              aria-label="Console Suggestions"
              className="max-h-[min(24dvh,12rem)] shrink-0 overflow-y-auto overscroll-y-contain touch-pan-y"
              data-testid="debug-console-suggestions"
            >
              {suggestions.map((name, index) => {
                const command = commands.find((entry) => entry.name === name);
                return (
                  <div
                    key={name}
                    id={`${listId}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === selectedIndex}
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "sm" }),
                      "flex h-auto min-h-8 w-full justify-start gap-3 rounded-none px-3 py-1 text-left touch-pan-y pointer-coarse:min-h-11",
                      index === selectedIndex && "bg-secondary",
                    )}
                    data-testid={`debug-console-suggest-${name}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applySuggestion(name)}
                  >
                    <span className="shrink-0 font-mono">{name}</span>
                    {command ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {commandUsage(command)}
                        {command.parameters.length ? " · " : ""}
                        {command.description}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
        <Separator />
        <form
          className="flex shrink-0 items-center gap-2 px-2 py-1.5"
          onSubmit={onSubmit}
        >
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            className="min-w-0 flex-1 font-mono pointer-coarse:min-h-11"
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Enter A Command…"
            aria-label="Console command"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listId : undefined}
            aria-activedescendant={
              suggestions.length > 0 ? `${listId}-${selectedIndex}` : undefined
            }
            data-testid="debug-console-input"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={false}
          />
          <Button
            type="submit"
            size="sm"
            className="pointer-coarse:min-h-11"
            disabled={executing || !draft.trim()}
            data-testid="debug-console-submit"
          >
            Run
          </Button>
        </form>
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 text-xs text-muted-foreground pointer-coarse:hidden">
          <span>↑ ↓ Select / History · Tab Complete · Enter Run</span>
          <span>Esc Close</span>
        </div>
        <div
          className="hidden shrink-0 flex-wrap gap-1 px-2 pb-1 pointer-coarse:flex"
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
      </SheetContent>
    </Sheet>
  );
}
