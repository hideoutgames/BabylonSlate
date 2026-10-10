import { useCallback, useEffect, useRef, useState } from "react";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Textarea } from "@babylonslate/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { useActiveDocumentId, useDocumentActions } from "../context/document-context";
import { usePlay } from "../context/play-context";
import { getApplicationVersion } from "../lib/changelog";
import { collectFeatureTestCheckEnvironment, formatFeatureTestCheckReport } from "../lib/feature-test-check-report";
import {
  FEATURE_TEST_CHECK_SCENES,
  frameStats,
  runFeatureTestCheck,
  type FeatureTestCheckDeps,
  type FeatureTestCheckMode,
  type FeatureTestCheckReport,
} from "../services/feature-test-check";
import {
  PLAY_PROBE_KEY,
  holdAutomatedSessionReporting,
  onPlaySessionClosed,
  playProbes,
  viewportProbes,
} from "../services/runtime-probes";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** requestAnimationFrame intervals for `durationMs`; a hidden page samples nothing. */
function sampleFrames(durationMs: number, signal: AbortSignal) {
  return new Promise<ReturnType<typeof frameStats>>((resolve) => {
    const intervals: number[] = [];
    let last: number | null = null;
    let frame = 0;
    const started = performance.now();
    const finish = () => { cancelAnimationFrame(frame); resolve(frameStats(intervals)); };
    const tick = (time: number) => {
      if (last !== null) intervals.push(time - last);
      last = time;
      if (signal.aborted || time - started >= durationMs) finish();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Frames stop in a background tab; the timer still ends the sample.
    setTimeout(finish, durationMs + 1000);
  });
}

type Phase = { kind: "idle" } | { kind: "running"; message: string } | { kind: "done"; text: string; report: FeatureTestCheckReport };

export interface FeatureTestCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Runs the Feature Test scenes through the editor and Play on this device and
 * produces a plain-text report to paste into a chat or issue.
 */
export function FeatureTestCheckDialog({ open, onOpenChange }: FeatureTestCheckDialogProps) {
  const { openDocument } = useDocumentActions();
  const activeDocumentId = useActiveDocumentId();
  const { requestPlay, playFromScene, setPlayFromScene, sessionOwner } = usePlay();
  const [mode, setMode] = useState<FeatureTestCheckMode>("quick");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(activeDocumentId);
  activeRef.current = activeDocumentId;
  const playRef = useRef({ requestPlay, playFromScene, setPlayFromScene, sessionOwner });
  playRef.current = { requestPlay, playFromScene, setPlayFromScene, sessionOwner };

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setCopied("idle");
    setPhase({ kind: "running", message: "Starting" });
    const active = activeRef.current;
    const current = FEATURE_TEST_CHECK_SCENES.find((scene) => `scene:${scene.path}` === active);
    const scenes = mode === "full" ? FEATURE_TEST_CHECK_SCENES : [current ?? FEATURE_TEST_CHECK_SCENES[0]];
    const pageErrors: string[] = [];
    const onError = (event: ErrorEvent) => { pageErrors.push(event.message || String(event.error)); };
    const onRejection = (event: PromiseRejectionEvent) => {
      pageErrors.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    const releaseReporting = holdAutomatedSessionReporting();
    const restorePlayFromScene = playRef.current.playFromScene;
    if (!restorePlayFromScene) playRef.current.setPlayFromScene(true);
    const deps: FeatureTestCheckDeps = {
      openScene: (path) => openDocument({ kind: "scene", path, label: path.split("/").pop()?.replace(".scene.babasset", "") ?? path }),
      activeDocumentId: () => activeRef.current,
      viewport: (documentId) => viewportProbes.get(documentId),
      startPlay: () => playRef.current.requestPlay({ saveChoice: "skip" }),
      play: () => playProbes.get(PLAY_PROBE_KEY),
      sessionIdle: () => playRef.current.sessionOwner.canStart(),
      onSessionClosed: onPlaySessionClosed,
      sampleFrames,
      now: () => performance.now(),
      sleep,
      onProgress: (message) => setPhase({ kind: "running", message }),
    };
    try {
      const report = await runFeatureTestCheck({ mode, scenes, deps, signal: controller.signal, pageErrors: () => [...pageErrors] });
      const environment = collectFeatureTestCheckEnvironment(getApplicationVersion());
      setPhase({ kind: "done", report, text: formatFeatureTestCheckReport(report, environment) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase({ kind: "done", report: { mode, startedAt: Date.now(), durationMs: 0, cancelled: true, scenes: [], pageErrors: [message] },
        text: `BabylonSlate Feature Test Check failed to run: ${message}` });
    } finally {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      releaseReporting();
      if (!restorePlayFromScene) playRef.current.setPlayFromScene(false);
      if (abortRef.current === controller) abortRef.current = null;
      onOpenChange(true);
    }
  }, [mode, onOpenChange, openDocument]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  if (phase.kind === "running") {
    return (
      <div className="fixed left-3 top-[max(0.5rem,env(safe-area-inset-top))] z-[70] flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md"
        role="status" aria-label="Feature Test Check" data-testid="feature-test-check-status">
        <SelectableText className="px-1 text-xs">Feature Test Check · {phase.message}</SelectableText>
        <Button size="sm" variant="secondary" data-testid="feature-test-check-cancel" onClick={() => abortRef.current?.abort()}>
          Cancel
        </Button>
      </div>
    );
  }

  const report = phase.kind === "done" ? phase.report : null;
  const passed = report?.scenes.filter((scene) => scene.passed).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(40rem,85vh)] w-full flex-col gap-3 sm:max-w-xl" data-testid="feature-test-check-dialog">
        <DialogHeader>
          <DialogTitle>Feature Test Check</DialogTitle>
          <DialogDescription>
            {report
              ? `${passed} of ${report.scenes.length} scenes passed${report.cancelled ? " before the check was cancelled" : ""}. Copy the report and paste it into your chat or issue.`
              : "Opens Feature Test scenes in the editor and in Play on this device, then writes a report you can copy."}
          </DialogDescription>
        </DialogHeader>
        {phase.kind === "done" ? (
          <Textarea
            readOnly
            value={phase.text}
            aria-label="Report"
            data-testid="feature-test-check-report"
            className="min-h-48 flex-1 font-mono text-xs"
          />
        ) : (
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={1}
            value={[mode]}
            onValueChange={(value) => { if (value[0] === "quick" || value[0] === "full") setMode(value[0]); }}
            aria-label="Check Scope"
          >
            <ToggleGroupItem value="quick" data-testid="feature-test-check-quick">Quick (Current Scene)</ToggleGroupItem>
            <ToggleGroupItem value="full" data-testid="feature-test-check-full">Full (All Scenes)</ToggleGroupItem>
          </ToggleGroup>
        )}
        <DialogFooter>
          {phase.kind === "done" ? (
            <>
              <Button variant="outline" onClick={() => setPhase({ kind: "idle" })}>Run Again</Button>
              <Button variant="secondary" data-testid="feature-test-check-copy" onClick={() => void copy(phase.text)}>
                {copied === "copied" ? "Copied" : copied === "failed" ? "Copy Failed: Select The Text" : "Copy Report"}
              </Button>
            </>
          ) : (
            <Button data-testid="feature-test-check-start" onClick={() => { onOpenChange(false); void start(); }}>
              Start
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
