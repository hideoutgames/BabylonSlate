import { useCallback, useEffect, useRef, useState } from "react";
import { EngineStore, type AbstractEngine, type Effect } from "@babylonjs/core";
import { estimateTextureMemory } from "@haptic/render";
import { getHostMemoryStats } from "@haptic/vfs";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Checkbox } from "@haptic/ui/components/checkbox";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Textarea } from "@haptic/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { useActiveDocumentId, useDocumentActions, useEditorShellState, useProjectState } from "../context/document-context";
import { usePlay } from "../context/play-context";
import {
  MAX_CHECK_RESOURCE_SAMPLES,
  clearUnfinishedCheck,
  loadCheckEnded,
  loadSavedCheck,
  saveCheckEnded,
  saveUnfinishedCheck,
} from "../lib/feature-test-check-record";
import {
  beginSecondPass,
  cancelPlannedReload,
  finishSecondPass,
  mergeBreakdownPasses,
  planSecondPass,
  secondPassInfo,
  type BreakdownProject,
  type BreakdownResumeMarker,
} from "../lib/feature-test-breakdown-ab";
import { FEATURE_TEST_AB_DEPS } from "../lib/feature-test-ab-deps";
import { FeatureTestCheckStatus } from "./feature-test-check-status";
import { formatFeatureTestCheckReport } from "../lib/feature-test-check-report";
import { collectDiagnosticEnvironment, copyText } from "../lib/diagnostic-info";
import {
  FEATURE_TEST_BREAKDOWN_SCENES,
  FEATURE_TEST_BREAKDOWN_TIER,
  FEATURE_TEST_CHECK_SCENES,
  frameStats,
  runFeatureTestCheck,
  warmDeviceMinutes,
  type FeatureTestBreakdownInfo,
  type FeatureTestCheckDeps,
  type FeatureTestCheckMode,
  type FeatureTestCheckReport,
  type FeatureTestCheckResources,
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

const MODE_DESCRIPTIONS: Record<FeatureTestCheckMode, string> = {
  quick: "Checks the current scene in the editor and in Play on this device, then writes a report you can copy. About a minute.",
  full: "Checks every Feature Test scene in the editor and in Play and runs the ft_ console commands. A few minutes.",
  benchmark: "Plays every Feature Test scene and measures each quality tier with the frame cap lifted, to find the settings this device holds at 60 and 30 fps. About ten minutes; keep the device awake and plugged in.",
  breakdown: "Plays FT_World and FT_Occlusion at the Medium tier and turns one feature off at a time (shadows, water, post-processing effects, captures, half resolution; occlusion culling from two cameras), measuring each at 60 fps between baselines. Then the editor reloads once and repeats it with preserveDrawingBuffer switched, and writes one report. The change shows what each feature costs this device's GPU. About 20 minutes; keep the device awake and plugged in.",
};

const MODES = ["quick", "full", "benchmark", "breakdown"] as const satisfies readonly FeatureTestCheckMode[];

const AB_DEPS = FEATURE_TEST_AB_DEPS;
/** How long the status shows before the A/B's reload, so it can still be cancelled. */
const RELOAD_DELAY_MS = 3_000;
/** A page still here this long after the reload was asked for did not reload (the browser kept it, e.g. for unsaved changes). */
const RELOAD_WATCHDOG_MS = 20_000;
/** After the reopened project mounts the dialog, before the second pass starts: the project's own first scene open settles. */
const RESUME_DELAY_MS = 2_000;

/** How often a running check samples what the editor holds, so a crash's report shows memory climbing. */
const RESOURCE_SAMPLE_MS = 2_000;

/** Shader programs every Engine holds that are still compiling: a Breakdown step samples only once none are. */
function compilingEffects(): number {
  let compiling = 0;
  for (const engine of EngineStore.Instances) {
    const compiled = (engine as AbstractEngine & { _compiledEffects?: Record<string, Effect> })._compiledEffects ?? {};
    for (const effect of Object.values(compiled)) if (!effect.isReady()) compiling += 1;
  }
  return compiling;
}

/** Shader programs, textures and memory every Engine holds now, and the Play view's drawn and held frames. */
async function sampleCheckResources(atMs: number, step: string): Promise<FeatureTestCheckResources> {
  let effects = 0;
  let compiling = 0;
  let textures = 0;
  let textureBytes = 0;
  for (const engine of EngineStore.Instances) {
    // Babylon 9.29 keeps every compiled Effect in `_compiledEffects` until it is released.
    const compiled = (engine as AbstractEngine & { _compiledEffects?: Record<string, Effect> })._compiledEffects ?? {};
    for (const effect of Object.values(compiled)) {
      effects += 1;
      if (!effect.isReady()) compiling += 1;
    }
    const memory = estimateTextureMemory(engine);
    textures += memory.textures;
    textureBytes += memory.bytes;
  }
  const presentation = playProbes.get(PLAY_PROBE_KEY)?.snapshot().rendering?.presentation;
  const host = await getHostMemoryStats().catch(() => null);
  return {
    atMs, step, effects, compiling, textures, textureBytes,
    playFrames: presentation ? { drawn: presentation.drawn, held: presentation.held, contextLosses: presentation.contextLosses } : null,
    jsHeapBytes: host?.jsHeapBytes ?? null,
    appFootprintBytes: host?.appFootprintBytes ?? null,
  };
}

type Phase = { kind: "idle" } | { kind: "running"; message: string } | { kind: "done"; text: string; report: FeatureTestCheckReport };

/** The report a check the app stopped during, or a finished one not yet shown, left behind; idle without one. */
function savedPhase(): Phase {
  const report = loadSavedCheck();
  return report ? { kind: "done", report, text: formatFeatureTestCheckReport(report, collectDiagnosticEnvironment()) } : { kind: "idle" };
}

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
  const { listedProjects } = useEditorShellState();
  const { projectName } = useProjectState();
  const { requestPlay, playFromScene, setPlayFromScene, sessionOwner } = usePlay();
  const [mode, setMode] = useState<FeatureTestCheckMode>("quick");
  const [breakdownAllScenes, setBreakdownAllScenes] = useState(false);
  const [phase, setPhase] = useState<Phase>(savedPhase);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const abortRef = useRef<AbortController | null>(null);
  /** What the status bar's Cancel does: stop the running check, or the A/B's pending reload. */
  const cancelRef = useRef<(() => void) | null>(null);
  const resumedRef = useRef(false);
  const activeRef = useRef(activeDocumentId);
  activeRef.current = activeDocumentId;
  const playRef = useRef({ requestPlay, playFromScene, setPlayFromScene, sessionOwner });
  playRef.current = { requestPlay, playFromScene, setPlayFromScene, sessionOwner };
  const projectRef = useRef({ listedProjects, projectName });
  projectRef.current = { listedProjects, projectName };

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * The open project's Homepage entry, to reopen after the A/B's reload: opening a project moves it to the top of the
   * list, so the first entry, when it has the project's name.
   */
  const currentProject = useCallback((): BreakdownProject | null => {
    const { listedProjects: listed, projectName: name } = projectRef.current;
    const entry = listed[0];
    return entry && entry.label === name ? { id: entry.id, name: entry.name, tier: entry.tier, label: entry.label } : null;
  }, []);

  /**
   * Runs one check, or one Breakdown pass, with the editor's own controls. `earlier` is the A/B's first pass, kept in
   * the crash record with this one so a crash reports both. Returns the report, and the error when the run threw.
   */
  const runCheck = useCallback(async (options: {
    mode: FeatureTestCheckMode;
    scenes: ReadonlyArray<{ name: string; path: string }>;
    breakdown?: FeatureTestBreakdownInfo;
    earlier?: FeatureTestCheckReport;
  }): Promise<{ report: FeatureTestCheckReport; error: string | null }> => {
    const { mode, scenes, breakdown, earlier } = options;
    const controller = new AbortController();
    abortRef.current = controller;
    cancelRef.current = () => controller.abort();
    setCopied("idle");
    setPhase({ kind: "running", message: "Starting" });
    clearUnfinishedCheck();
    const startedAt = performance.now();
    const record: { step: string; report: FeatureTestCheckReport | null; resources: FeatureTestCheckResources[] } = { step: "Starting", report: null, resources: [] };
    let running = true;
    const sample = async () => {
      const resources = await sampleCheckResources(Math.round(performance.now() - startedAt), record.step);
      if (!running || !record.report) return;
      record.resources.push(resources);
      if (record.resources.length > MAX_CHECK_RESOURCE_SAMPLES) record.resources.shift();
      saveUnfinishedCheck({ step: record.step, report: record.report, resources: record.resources });
    };
    const sampler = setInterval(() => { void sample(); }, RESOURCE_SAMPLE_MS);
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
      openScene: (path) => openDocument({ kind: "scene", path, label: path.split("/").pop()?.replace(".scene.hasset", "") ?? path }),
      activeDocumentId: () => activeRef.current,
      viewport: (documentId) => viewportProbes.get(documentId),
      startPlay: () => playRef.current.requestPlay({ saveChoice: "skip" }),
      play: () => playProbes.get(PLAY_PROBE_KEY),
      sessionIdle: () => playRef.current.sessionOwner.canStart(),
      onSessionClosed: onPlaySessionClosed,
      sampleFrames,
      compiling: compilingEffects,
      now: () => performance.now(),
      sleep,
      onProgress: (message) => setPhase({ kind: "running", message }),
    };
    try {
      const report = await runFeatureTestCheck({
        mode, scenes, deps, signal: controller.signal, pageErrors: () => [...pageErrors], breakdown,
        onStep: (step, partial) => { record.step = step; record.report = earlier ? mergeBreakdownPasses(earlier, partial) : partial; void sample(); },
      });
      return { report, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        report: { mode, startedAt: Date.now(), durationMs: 0, cancelled: true, scenes: [], pageErrors: [message], ...(breakdown ? { breakdown } : {}) },
        error: message,
      };
    } finally {
      running = false;
      clearInterval(sampler);
      clearUnfinishedCheck();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      releaseReporting();
      if (!restorePlayFromScene) playRef.current.setPlayFromScene(false);
      if (abortRef.current === controller) abortRef.current = null;
      cancelRef.current = null;
    }
  }, [openDocument]);

  /** Shows the final report and records when this check ended, for the next Breakdown's warm-device note. */
  const finish = useCallback((report: FeatureTestCheckReport, error: string | null = null) => {
    saveCheckEnded(Date.now());
    setPhase({
      kind: "done", report,
      text: error && !report.scenes.length ? `Haptic Feature Test Check failed to run: ${error}` : formatFeatureTestCheckReport(report, collectDiagnosticEnvironment()),
    });
    onOpenChange(true);
  }, [onOpenChange]);

  /** The A/B's reload, shown for a moment so it can be cancelled; a page that outlives it did not reload. */
  const reloadForSecondPass = useCallback((marker: BreakdownResumeMarker) => {
    setPhase({ kind: "running", message: `Reloading the editor for pass 2 of 2 (preserveDrawingBuffer ${marker.originalPreserve ? "off" : "on"})` });
    let settled = false;
    const giveUp = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(reload);
      clearTimeout(watchdog);
      cancelRef.current = null;
      finish(cancelPlannedReload(marker, reason, AB_DEPS));
    };
    cancelRef.current = () => giveUp("cancelled before the reload");
    const reload = setTimeout(() => { if (!settled) window.location.reload(); }, RELOAD_DELAY_MS);
    const watchdog = setTimeout(() => giveUp("the editor did not reload"), RELOAD_DELAY_MS + RELOAD_WATCHDOG_MS);
  }, [finish]);

  const start = useCallback(async () => {
    const active = activeRef.current;
    const current = FEATURE_TEST_CHECK_SCENES.find((scene) => `scene:${scene.path}` === active);
    const scenes = mode === "quick" ? [current ?? FEATURE_TEST_CHECK_SCENES[0]]
      : mode === "breakdown" && !breakdownAllScenes ? FEATURE_TEST_BREAKDOWN_SCENES
        : FEATURE_TEST_CHECK_SCENES;
    if (mode !== "breakdown") {
      const { report, error } = await runCheck({ mode, scenes });
      finish(report, error);
      return;
    }
    // Pass 1 at the stored setting; the warm-device note is decided once, before it.
    const breakdown: FeatureTestBreakdownInfo = {
      tier: FEATURE_TEST_BREAKDOWN_TIER,
      warmMinutes: warmDeviceMinutes(Date.now(), loadCheckEnded()),
      passes: [{ preserveDrawingBuffer: AB_DEPS.preserve() }],
      notes: [],
    };
    const { report: first, error } = await runCheck({ mode, scenes, breakdown });
    if (error) { finish(first, error); return; }
    const plan = planSecondPass(first, { project: currentProject(), scenes }, AB_DEPS);
    if (plan.kind === "done") finish(plan.report);
    else reloadForSecondPass(plan.marker);
  }, [mode, breakdownAllScenes, runCheck, finish, reloadForSecondPass, currentProject]);

  /** The A/B's second pass, in the project Home reopened after the reload: the same scenes, then one report of both. */
  const runSecondPass = useCallback(async (marker: BreakdownResumeMarker) => {
    setMode("breakdown");
    const { report: second, error } = await runCheck({
      mode: "breakdown", scenes: marker.scenes, breakdown: secondPassInfo(marker), earlier: marker.first,
    });
    finish(finishSecondPass(marker, second, AB_DEPS), error && !marker.first.scenes.length ? error : null);
  }, [runCheck, finish]);

  // A Breakdown waiting for its second pass resumes once the reopened project mounts this dialog.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (resumedRef.current) return;
      const marker = beginSecondPass(projectRef.current.listedProjects[0]?.id ?? null, AB_DEPS);
      if (!marker) return;
      resumedRef.current = true;
      void runSecondPass(marker);
    }, RESUME_DELAY_MS);
    return () => clearTimeout(timer);
  }, [runSecondPass]);

  const copy = async (text: string) => {
    setCopied(await copyText(text) ? "copied" : "failed");
  };

  if (phase.kind === "running") {
    return (
      <FeatureTestCheckStatus message={phase.message} action={
        <Button size="sm" variant="secondary" data-testid="feature-test-check-cancel" onClick={() => cancelRef.current?.()}>
          Cancel
        </Button>
      } />
    );
  }

  const report = phase.kind === "done" ? phase.report : null;
  const passed = report?.scenes.filter((scene) => scene.passed).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(40rem,85vh)] w-full sm:max-w-xl" bodyClassName="flex flex-col gap-3" data-testid="feature-test-check-dialog">
        <DialogHeader>
          <DialogTitle>Feature Test Check</DialogTitle>
          <DialogDescription>
            {report?.unfinished
              ? `The last check did not finish: the app stopped while ${report.unfinished.step}. Copy its report and paste it into your chat or issue.`
              : report
                ? `${passed} of ${report.scenes.length} scenes passed${report.cancelled ? " before the check was cancelled" : ""}. Copy the report and paste it into your chat or issue.`
                : MODE_DESCRIPTIONS[mode]}
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
          <>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={1}
              value={[mode]}
              onValueChange={(value) => { const next = MODES.find((entry) => entry === value[0]); if (next) setMode(next); }}
              aria-label="Check Scope"
            >
              <ToggleGroupItem value="quick" data-testid="feature-test-check-quick">Quick (Current Scene)</ToggleGroupItem>
              <ToggleGroupItem value="full" data-testid="feature-test-check-full">Full (All Scenes)</ToggleGroupItem>
              <ToggleGroupItem value="benchmark" data-testid="feature-test-check-benchmark">Benchmark</ToggleGroupItem>
              <ToggleGroupItem value="breakdown" data-testid="feature-test-check-breakdown">Breakdown</ToggleGroupItem>
            </ToggleGroup>
            {mode === "breakdown" ? (
              <Field orientation="horizontal" className="items-center">
                <Checkbox
                  id="feature-test-check-breakdown-all"
                  checked={breakdownAllScenes}
                  data-testid="feature-test-check-breakdown-all"
                  onCheckedChange={(checked) => setBreakdownAllScenes(checked === true)}
                />
                <FieldLabel htmlFor="feature-test-check-breakdown-all" className="flex-1 font-normal">All Scenes</FieldLabel>
              </Field>
            ) : null}
          </>
        )}
        <DialogFooter>
          {phase.kind === "done" ? (
            <>
              <Button variant="outline" onClick={() => { clearUnfinishedCheck(); setPhase({ kind: "idle" }); }}>Run Again</Button>
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
