import { ActivityIcon, CameraIcon, GaugeIcon, TerminalIcon, XIcon } from "lucide-react";
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
  PREVIEW_CONSOLE_CONTEXT_MESSAGE,
} from "@babylonslate/exporter";
import {
  createUserCommand,
  createCommandRegistry,
  type ConsoleCompletionContext,
  type TracePayload,
} from "@babylonslate/debugger";
import {
  isExpectedPreviewMessage,
  previewTargetFromSrc,
} from "../lib/preview-build-handoff";
import { DebugConsole } from "./debug-console";
import { useDebugConsoleLogs } from "../lib/use-debug-console-logs";
import { DebugBehaviourTreeDialog } from "./debug-behaviour-tree-dialog";
import { Button } from "@babylonslate/ui/components/button";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SelectableText } from "@babylonslate/editor-kit";
import { useDiagnosticResultsStore } from "../context/diagnostic-results-context";
import { createPreviewDiagnostics } from "../services/preview-diagnostics";

export type PreviewBuildOverlayProps = {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onClose: () => void;
  /** Called after this iframe presentation has unmounted. */
  onDetached?: () => void;
  onLoad?: () => void;
  onTrace?: (trace: TracePayload) => void;
  /** The shared session owner invokes this before closing or replacing Preview. */
  registerBeforeStop?: (finalize: () => Promise<void>) => () => void;
  /** Boot failure reported by the player, so the black canvas is explained. */
  error?: string | null;
  /** Debug-menu overlay buttons, shared with Play. */
  showStats?: boolean;
  showConsole?: boolean;
  showProfiler?: boolean;
};

export function PreviewBuildOverlay({
  src,
  iframeRef,
  onClose,
  onDetached,
  onLoad,
  onTrace,
  registerBeforeStop,
  error = null,
  showStats = true,
  showConsole = true,
  showProfiler = true,
}: PreviewBuildOverlayProps) {
  const onDetachedRef = useRef(onDetached);
  onDetachedRef.current = onDetached;
  useEffect(() => () => { onDetachedRef.current?.(); }, []);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // The player starts with Stats hidden; console commands report changes back.
  const [statsOpen, setStatsOpen] = useState(false);
  const { logs, pushLog } = useDebugConsoleLogs();
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
  const stoppingRef = useRef(false);
  const diagnosticResults = useDiagnosticResultsStore();
  const diagnosticOwner = useRef<{ adapter: ReturnType<typeof createPreviewDiagnostics>; release(): void; reportError(reason: string): void } | null>(null);
  const finishRef = useRef<() => void | Promise<void>>(() => undefined);
  const beforeStopRef = useRef<() => Promise<void>>(async () => undefined);
  const finalization = useRef<Promise<void> | null>(null);
  const closeRequested = useRef(false);
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
    const registry = createCommandRegistry({ includeDebug: true });
    for (const entry of userCommands)
      registry.register(
        createUserCommand({
          ...entry,
          run: () => ({ success: true, output: "" }),
        }),
      );
    return registry.list();
  }, [userCommands]);
  const completionContext = useMemo(
    () => ({
      ...context,
      commands: commands.map((command) => command.name),
    }),
    [commands, context],
  );
  const execute = (line: string, timeoutMs = 10000) =>
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
      }, timeoutMs);
      pending.current.set(requestId, { resolve, timer });
      frame.postMessage(
        { type: PREVIEW_CONSOLE_REQUEST_MESSAGE, requestId, line },
        origin,
      );
    });
  const finalize = (): Promise<void> => {
    if (finalization.current) return finalization.current;
    stoppingRef.current = true;
    setStopping(true);
    finalization.current = (async () => {
      const owner = diagnosticOwner.current;
      if (owner) {
        try { await owner.adapter.finish(); }
        catch (failure) {
          const reason = failure instanceof Error ? failure.message : String(failure);
          pushLog("error", reason);
          owner.reportError(reason);
        } finally { owner.release(); }
      }
      try {
        if (ready.current && !error) await execute("snapshot stop", 2000);
        if (lastTrace.current) onTrace?.(lastTrace.current);
      } catch (failure) { pushLog("error", failure instanceof Error ? failure.message : String(failure)); }
    })();
    return finalization.current;
  };
  const finish = async () => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    await finalize().finally(onClose);
  };
  finishRef.current = finish;
  beforeStopRef.current = finalize;
  useEffect(() => registerBeforeStop?.(() => beforeStopRef.current()), [registerBeforeStop]);
  useEffect(() => {
    if (!diagnosticResults) return;
    const adapter = createPreviewDiagnostics({
      source: () => iframeRef.current?.contentWindow,
      origin,
      onProfile: (profile) => { lease.publishProfile(profile); },
      onError: (reason) => { pushLog("error", reason); lease.publishError(reason); },
    });
    const lease = diagnosticResults.bindSession({
      mode: "preview",
      async startProfile(settings) {
        if (stoppingRef.current) throw new Error("Preview Build is stopping.");
        const result = await adapter.startProfile(settings);
        if (!result.success) throw new Error(result.reason ?? "Preview recording could not start.");
      },
      async stopProfile() {
        const result = await adapter.stopProfile();
        if (!result.success) throw new Error(result.reason ?? "Preview recording could not stop.");
        return adapter.lastProfile;
      },
      captureFrame() {
        if (stoppingRef.current) return Promise.reject(new Error("Preview Build is stopping."));
        return adapter.captureFrame();
      },
      stopSession: () => finishRef.current(),
    });
    const owner = { adapter, release: lease.release, reportError: lease.publishError };
    diagnosticOwner.current = owner;
    return () => {
      if (diagnosticOwner.current === owner) diagnosticOwner.current = null;
      adapter.dispose();
      lease.release();
    };
  }, [diagnosticResults, iframeRef, origin, src, pushLog]);
  useEffect(() => {
    let lastSuppressed: boolean | undefined;
    const sync = () => {
      if (stoppingRef.current) return;
      const owner = diagnosticOwner.current;
      if (!owner) return;
      const suppressed = consoleOpen || treeOpen || diagnosticResults?.getSnapshot().open === true;
      if (lastSuppressed === suppressed) return;
      lastSuppressed = suppressed;
      void owner.adapter.setInputSuppressed(suppressed).then(result => {
        if (!result.success && !stoppingRef.current) owner.reportError(result.reason ?? "Preview input ownership failed.");
      });
    };
    sync();
    return diagnosticResults?.subscribe(sync);
  }, [diagnosticResults, consoleOpen, treeOpen, src]);
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
        if (data.commands !== undefined) {
          ready.current = true;
          setUserCommands(data.commands);
        }
        setContext((previous) => ({
          scenes: data.scenes ?? previous.scenes,
          actors: data.actors ?? previous.actors,
        }));
      }
      if (data?.type !== PREVIEW_CONSOLE_EVENT_MESSAGE) return;
      const command = data.command;
      if (
        ["log", "print", "diagnostic"].includes(command?.type) &&
        typeof command.message === "string"
      ) {
        pushLog(
          command.type === "print" ? "print" : (command.severity ?? "log"),
          command.message,
        );
      }
      if (command?.type === "setBehaviourTreeDebug") {
        setTreeOpen(command.enabled === true);
        if (command.enabled) setConsoleOpen(false);
      }
      if (command?.type === "behaviourTreeSnapshot") setTrees(command.trees);
      if (command?.type === "setShowFps") setStatsOpen(command.enabled === true);
      if (command?.type === "setStat" && command.enabled === true) setStatsOpen(true);
      if (command?.type === "trace")
        lastTrace.current = command.payload as TracePayload;
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
  }, [iframeRef, origin, pushLog]);
  useEffect(() => {
    if (!consoleOpen) return;
    const refresh = () =>
      iframeRef.current?.contentWindow?.postMessage(
        { type: PREVIEW_CONSOLE_CONTEXT_MESSAGE },
        origin,
      );
    refresh();
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [consoleOpen, iframeRef, origin]);
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
      <div className="safe-overlay-chrome pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-start justify-end gap-2">
        {showProfiler && diagnosticResults ? <>
          <Button
            size="touch"
            variant="secondary"
            className="pointer-events-auto"
            data-testid="preview-build-profiler-open"
            disabled={stopping || !!error}
            onClick={() => diagnosticResults.open("summary")}
          >
            <GaugeIcon data-icon="inline-start" />
            Profiler
          </Button>
          <Button
            size="touch"
            variant="secondary"
            className="pointer-events-auto"
            data-testid="preview-build-capture-frame"
            disabled={stopping || !!error}
            onClick={() => void diagnosticResults.captureFrame()}
          >
            <CameraIcon data-icon="inline-start" />
            Capture Frame
          </Button>
        </> : null}
        {showStats ? (
          <Toggle
            size="touch"
            variant="secondary"
            className="pointer-events-auto"
            pressed={statsOpen}
            data-testid="preview-build-stats-toggle"
            aria-label="Stats"
            disabled={stopping || !!error}
            onPressedChange={(pressed) => {
              setStatsOpen(pressed);
              void execute(`showfps ${pressed ? "on" : "off"}`);
            }}
          >
            <ActivityIcon data-icon="inline-start" />
            Stats
          </Toggle>
        ) : null}
        {showConsole ? (
          <Button
            size="touch"
            variant="secondary"
            className="pointer-events-auto"
            aria-label="Console"
            data-testid="preview-build-console-open"
            disabled={stopping}
            onClick={() => setConsoleOpen(true)}
          >
            <TerminalIcon data-icon="inline-start" />
            Console
          </Button>
        ) : null}
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
        completionContext={completionContext}
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
