import { describe, expect, it } from "vitest";
import type { SessionReportEntry } from "@haptic/runtime";
import { FEATURE_TEST_BENCHMARK_PROFILES, runFeatureTestCheck, type FeatureTestCheckDeps } from "./feature-test-check";
import type { PlaySessionResult } from "./play-session";
import type { PlayProbe } from "./runtime-probes";
import type { RenderDiagnostics } from "@haptic/render";

type SceneBehavior = {
  open?: "ready" | "failed" | "blocked";
  play?: "loads" | "stuck";
  commands?: Record<string, { success: boolean; output: string }>;
  diagnostics?: SessionReportEntry[];
};

function diagnostic(severity: "error" | "warning", message: string): SessionReportEntry {
  return { code: "TEST", message, severity, frameId: 1, count: 1, firstFrameId: 1, lastFrameId: 1 };
}

/** A fake editor whose clock advances only when the runner sleeps. */
function fakeEditor(
  scenes: Record<string, SceneBehavior>,
  onSleep?: (now: number) => void,
  /** The Play view's presentation counts at a time, after the given commands. */
  presentation?: (now: number, commands: readonly string[]) => { drawn: number; held: number },
) {
  let now = 0;
  let active: string | null = null;
  let play: PlayProbe | null = null;
  let playScene: string | null = null;
  const listeners = new Set<(result: PlaySessionResult) => void>();
  const started: string[] = [];
  const stopped: string[] = [];
  const commands: string[] = [];
  const sampled: { now: number; after: string | null }[] = [];
  const behavior =(path: string | null) => scenes[(path ?? "").replace(/^scene:/, "")] ?? {};
  const deps: FeatureTestCheckDeps = {
    openScene: async (path) => { if (behavior(path).open !== "blocked") active = `scene:${path}`; },
    activeDocumentId: () => active,
    viewport: (id) => id === active ? {
      ready: () => (behavior(id).open ?? "ready") === "ready",
      failed: () => behavior(id).open === "failed",
      phase: () => behavior(id).open === "failed" ? "Loading Models" : null,
      error: () => behavior(id).open === "failed" ? new Error("Scene construction failed.", { cause: new Error("WebGPU device lost") }) : undefined,
      gpu: () => ({ api: "webgpu", vendor: "apple", renderer: "apple-a16", version: null }),
    } : null,
    startPlay: async () => {
      playScene = active;
      started.push(playScene!);
      const scene = behavior(playScene);
      play = {
        loadingPhase: () => scene.play === "stuck" ? { phase: "Loading Models", progress: 45 } : null,
        tickIndex: () => 12,
        runtimeFps: () => 60,
        snapshot: () => ({
          drawCalls: 10, meshes: 20, textures: 5, accountedBytes: 0,
          rendering: presentation
            ? ({
              presentation: presentation(now, commands), cpuMs: 4, gpuMs: null, width: 100, height: 100, scalingLevel: 1,
              pipeline: { effective: { renderPath: "forward" } },
            } as unknown as RenderDiagnostics)
            : null,
        }),
        problemLogs: () => [],
        executeConsoleCommand: async (line) => {
          commands.push(line);
          if (line === "framecap") return { success: true, output: "framecap 30" };
          return scene.commands?.[line] ?? { success: true, output: `${line} ok` };
        },
        stop: () => {
          if (!play) return;
          stopped.push(playScene!);
          play = null;
          const result: PlaySessionResult = {
            diagnostics: scene.diagnostics ?? [], droppedDiagnostics: 0, textureCountBefore: 5,
            released: Promise.resolve({ textureCountAfter: 5, textureLeak: false, quarantined: false }),
            runtimeMode: "worker", lastTrace: null,
          };
          for (const listener of [...listeners]) listener(result);
        },
      };
    },
    play: () => play,
    sessionIdle: () => play === null,
    onSessionClosed: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sampleFrames: async () => {
      sampled.push({ now, after: commands.at(-1) ?? null });
      return { frames: 60, durationMs: 1000, fps: 60, p95Ms: 17, maxMs: 20, stalls: 0 };
    },
    now: () => now,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      now += ms;
      onSleep?.(now);
      signal.throwIfAborted();
    },
  };
  return { deps, started, stopped, commands, sampled };
}

const scene = (name: string) => ({ name, path: `assets/${name}.scene.hasset` });

describe("runFeatureTestCheck", () => {
  it("stops a Play that never finishes loading, records where it stuck, and checks the next scene", async () => {
    const editor = fakeEditor({ "assets/stuck.scene.hasset": { play: "stuck" } });
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("stuck"), scene("fine")], deps: editor.deps, signal: new AbortController().signal,
    });
    const [stuck, fine] = report.scenes;
    expect(stuck.passed).toBe(false);
    expect(stuck.play).toMatchObject({ status: "timeout", phase: "Loading Models 45%" });
    expect(stuck.problems.join(" ")).toContain("did not finish loading");
    expect(editor.stopped).toEqual(["scene:assets/stuck.scene.hasset", "scene:assets/fine.scene.hasset"]);
    expect(fine.passed).toBe(true);
    expect(fine.play.commands).toMatchObject([{ line: "ft_stats", success: true, output: "ft_stats ok" }]);
    expect(report.cancelled).toBe(false);
  });

  it("fails a scene on a failed command or a session error, but not on warnings", async () => {
    const editor = fakeEditor({
      "assets/command.scene.hasset": { commands: { ft_stats: { success: false, output: "Unknown command" } } },
      "assets/error.scene.hasset": { diagnostics: [diagnostic("error", "Boom")] },
      "assets/warning.scene.hasset": { diagnostics: [diagnostic("warning", "Slow")] },
    });
    const report = await runFeatureTestCheck({
      mode: "quick", scenes: [scene("command"), scene("error"), scene("warning")], deps: editor.deps, signal: new AbortController().signal,
    });
    expect(report.scenes.map((entry) => [entry.name, entry.passed])).toEqual([["command", false], ["error", false], ["warning", true]]);
    expect(report.scenes[0].problems).toEqual(["Command ft_stats failed: Unknown command."]);
    expect(report.scenes[1].session?.diagnostics).toHaveLength(1);
  });

  it("reports a scene the editor never opened without starting Play", async () => {
    const editor = fakeEditor({ "assets/blocked.scene.hasset": { open: "blocked" }, "assets/broken.scene.hasset": { open: "failed" } });
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("blocked"), scene("broken")], deps: editor.deps, signal: new AbortController().signal,
    });
    expect(report.scenes.map((entry) => entry.editor.status)).toEqual(["not-opened", "failed"]);
    const broken = report.scenes[1].editor;
    expect(broken.gpu?.renderer).toBe("apple-a16");
    expect(broken.error?.[0]).toBe("Error: Scene construction failed.");
    expect(broken.error).toContain("  Error: WebGPU device lost");
    expect(report.scenes.map((entry) => entry.play.status)).toEqual(["not-started", "not-started"]);
    expect(editor.started).toEqual([]);
  });

  it("stops Play and returns the partial report when cancelled", async () => {
    const controller = new AbortController();
    const editor = fakeEditor({ "assets/stuck.scene.hasset": { play: "stuck" } }, (now) => { if (now >= 10_000) controller.abort(); });
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("stuck"), scene("never")], deps: editor.deps, signal: controller.signal,
    });
    expect(report.cancelled).toBe(true);
    expect(report.scenes.map((entry) => [entry.name, entry.passed, entry.problems])).toEqual([
      ["stuck", false, ["Cancelled while checking this scene."]],
    ]);
    expect(editor.stopped).toEqual(["scene:assets/stuck.scene.hasset"]);
    expect(editor.started).toEqual(["scene:assets/stuck.scene.hasset"]);
  });

  it("benchmarks every profile with the frame cap lifted, then restores the session settings", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal,
    });
    const [main] = report.scenes;
    expect(main.passed).toBe(true);
    expect(main.play.benchmark.map((sample) => sample.label)).toEqual(FEATURE_TEST_BENCHMARK_PROFILES.map((profile) => profile.label));
    expect(editor.commands.slice(0, 2)).toEqual(["framecap", "framecap 240"]);
    expect(editor.commands.slice(-4)).toEqual(["fixedlights reset", "quality reset", "renderpath reset", "framecap 30"]);
    expect(editor.commands).toContain("fixedlights branch");
    expect(editor.commands).toContain("renderpath clusteredForward");
    expect(editor.commands).not.toContain("ft_stats");
  });

  it("samples a recompiling profile only once the view draws without held frames, within a bound", async () => {
    // `fixedlights multiply` holds the view for 20 s of new shaders; `fixedlights branch` never stops holding.
    const counts = { drawn: 0, held: 0 };
    const issuedAt = new Map<string, number>();
    let heldUntil = -1;
    const editor = fakeEditor({}, undefined, (now, commands) => {
      const last = commands.at(-1) ?? "";
      if (!issuedAt.has(last) && (last === "fixedlights multiply" || last === "fixedlights branch")) {
        issuedAt.set(last, now);
        heldUntil = last === "fixedlights multiply" ? now + 20_000 : Number.POSITIVE_INFINITY;
      }
      if (now < heldUntil) counts.held++;
      else counts.drawn++;
      return { ...counts };
    });
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal,
    });
    const sampledAt = editor.sampled.find((sample) => sample.after === "fixedlights multiply")!.now;
    // Held 20 s, then steady draws and the 3 s settle.
    expect(sampledAt - issuedAt.get("fixedlights multiply")!).toBeGreaterThanOrEqual(23_000);
    const benchmark = report.scenes[0]!.play.benchmark;
    expect(benchmark.find((sample) => sample.label === "medium · fixed lights")!.failed).toEqual([]);
    expect(benchmark.find((sample) => sample.label === "medium · fixed lights · branch")!.failed)
      .toEqual(["The view still held frames for new shaders after 90 s."]);
  });
});
