import { TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DebugBehaviourTree,
  ScriptBundleEntry,
} from "@babylonslate/bridge";
import {
  PREVIEW_CONSOLE_REQUEST_MESSAGE,
  PREVIEW_CONSOLE_RESULT_MESSAGE,
  PREVIEW_CONSOLE_EVENT_MESSAGE,
  PREVIEW_CONSOLE_CATALOG_MESSAGE,
} from "@babylonslate/exporter";
import {
  createUserCommand,
  type ConsoleCompletionContext,
  type TracePayload,
} from "@babylonslate/debugger";
import { playConsoleCommands } from "../lib/play-console";
import {
  isExpectedPreviewMessage,
  previewTargetFromSrc,
} from "../lib/preview-build-handoff";
import { DebugConsole, type DebugConsoleLogEntry } from "./debug-console";
import { DebugBehaviourTreeDialog } from "./debug-behaviour-tree-dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SelectableText } from "@babylonslate/editor-kit";

export type PreviewBuildOverlayProps = {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onClose: () => void;
  onLoad?: () => void;
  onTrace?: (trace: TracePayload) => void;
  /** Boot failure reported by the player, so the black canvas is explained. */
  error?: string | null;
};

export function PreviewBuildOverlay({
  src,
  iframeRef,
  onClose,
  onLoad,
  onTrace,
  error = null,
}: PreviewBuildOverlayProps) {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<DebugConsoleLogEntry[]>([]);
  const [trees, setTrees] = useState<readonly DebugBehaviourTree[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const [userCommands, setUserCommands] = useState<
    NonNullable<ScriptBundleEntry["command"]>[]
  >([]);
  const [context, setContext] = useState<ConsoleCompletionContext>({});
  const sequence = useRef(0);
  const lastTrace = useRef<TracePayload | null>(null);
  const ready = useRef(false);
  const [stopping, setStopping] = useState(false);
  const pending = useRef(
    new Map<
      number,
      {
        resolve: (value: { success: boolean; output: string }) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const origin = previewTargetFromSrc(src, window.location.href).origin;
  const commands = useMemo(() => {
    const builtins = playConsoleCommands();
    return [
      ...builtins,
      ...userCommands
        .filter(
          (entry) => !builtins.some((command) => command.name === entry.name),
        )
        .map((entry) =>
          createUserCommand({
            ...entry,
            run: () => ({ success: true, output: "" }),
          }),
        ),
    ];
  }, [userCommands]);
  const execute = (line: string) =>
    new Promise<{ success: boolean; output: string }>((resolve) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame) {
        resolve({ success: false, output: "Player is unavailable" });
        return;
      }
      const requestId = ++sequence.current;
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        resolve({
          success: false,
          output: "Player did not respond to the command",
        });
      }, 10000);
      pending.current.set(requestId, { resolve, timer });
      frame.postMessage(
        { type: PREVIEW_CONSOLE_REQUEST_MESSAGE, requestId, line },
        origin,
      );
    });
  const finish = () => {
    const close = () => { if (lastTrace.current) onTrace?.(lastTrace.current); onClose(); };
    if (!ready.current || error) { close(); return; }
    setStopping(true);
    void execute("snapshot stop").finally(close);
  };
  useEffect(() => {
    const requests = pending.current;
    const receive = (event: MessageEvent) => {
      if (
        !isExpectedPreviewMessage(
          event,
          iframeRef.current?.contentWindow,
          origin,
        )
      )
        return;
      const data = event.data;
      if (data?.type === PREVIEW_CONSOLE_RESULT_MESSAGE) {
        const request = requests.get(data.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        requests.delete(data.requestId);
        request.resolve({
          success: data.success === true,
          output: String(data.output ?? ""),
        });
      }
      if (data?.type === PREVIEW_CONSOLE_CATALOG_MESSAGE) {
        ready.current = true;
        setUserCommands(data.commands ?? []);
        setContext({ scenes: data.scenes ?? [], actors: data.actors ?? [] });
      }
      if (data?.type !== PREVIEW_CONSOLE_EVENT_MESSAGE) return;
      const command = data.command;
      if (
        ["log", "print", "diagnostic"].includes(command?.type) &&
        typeof command.message === "string"
      ) {
        const entry = {
          id: ++sequence.current,
          timestamp: Date.now(),
          severity:
            command.type === "print" ? "print" : (command.severity ?? "log"),
          message: command.message,
        };
        setLogs((previous) => [...previous.slice(-499), entry]);
      }
      if (command?.type === "setBehaviourTreeDebug") {
        setTreeOpen(command.enabled === true);
        if (command.enabled) setConsoleOpen(false);
      }
      if (command?.type === "behaviourTreeSnapshot") setTrees(command.trees);
      if (command?.type === "trace") lastTrace.current = command.payload as TracePayload;
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.resolve({ success: false, output: "Play session stopped" });
      }
      requests.clear();
    };
  }, [iframeRef, origin]);
  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      data-testid="preview-build-overlay"
    >
      <iframe
        ref={iframeRef}
        title="Preview Build"
        src={src}
        className="absolute inset-0 h-full w-full border-0 bg-black outline-none focus-visible:outline-none"
        data-testid="preview-build-iframe"
        onLoad={onLoad}
      />
      {error ? (
        <div
          className="safe-overlay-chrome absolute inset-x-0 top-16 z-20"
          style={{ "--safe-overlay-pad": "1rem" } as React.CSSProperties}
        >
          <Alert variant="destructive" data-testid="preview-build-error">
            <AlertTitle>Preview Build Failed To Start</AlertTitle>
            <AlertDescription>
              <SelectableText>{error}</SelectableText>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="safe-overlay-chrome pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-end gap-2">
        <Button
          size="touch"
          variant="secondary"
          className="pointer-events-auto"
          aria-label="Console"
          onClick={() => setConsoleOpen(true)}
        >
          <TerminalIcon data-icon="inline-start" />
          Console
        </Button>
        <Button
          size="touch"
          variant="secondary"
          className="pointer-events-auto"
          aria-label="Stop"
          data-testid="preview-build-close"
          disabled={stopping}
          onClick={finish}
        >
          <XIcon data-icon="inline-start" />
          Stop
        </Button>
      </div>
      <DebugConsole
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        commands={commands}
        completionContext={context}
        logs={logs}
        onExecute={execute}
      />
      <DebugBehaviourTreeDialog
        open={treeOpen}
        onOpenChange={(open) => {
          setTreeOpen(open);
          if (!open) void execute("behaviourtreedebug off");
        }}
        trees={trees}
      />
    </div>
  );
}
