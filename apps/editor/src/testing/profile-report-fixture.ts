import type { FeatureTestBenchmarkSample, FeatureTestCheckReport, SampledGpuProbe } from "../services/feature-test-check";

/**
 * A Profile report of `rows` rows shaped like a device's: every field a Profile row fills, at the sizes the probes cap
 * them at or a main-scene run reaches (four frame structures of 40 passes each, 36 settings fields, a timer pass list,
 * a program census). Deterministic. The rows run as the Profile's: light 31, heavy 25, mirror 13, then the drift.
 */
export function profileReportFixture(rows: number): FeatureTestCheckReport {
  return {
    mode: "profile", startedAt: Date.UTC(2026, 10, 20, 12), durationMs: rows * 8_000, cancelled: false, pageErrors: [],
    scenes: [{
      name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
      editor: { status: "ready", ms: 4200, phase: null, frames: null, error: null, gpu: { vendor: "Apple Inc.", renderer: "Apple GPU" } },
      play: {
        status: "loaded", ms: 9000, phase: null, frames: null, runtimeFps: 40, ticksPerSecond: 60, snapshot: null, presentation: null,
        firstDraws: null, commands: [], logs: [],
        profile: { instancePool: { groups: 18, retained: 2, pooled: 410, rekeys: 0 }, endChanges: null, holdRate: { heldPerSecond: 0.2, share: 0.01 } },
        benchmark: Array.from({ length: rows }, (_, index) => profileRow(index)),
      },
      session: null,
    }],
  } as unknown as FeatureTestCheckReport;
}

const VIEWS: Array<[string, number]> = [["light", 31], ["heavy", 25], ["mirror", 13], ["heavy", 1]];

function rowLabel(index: number): { view: string; label: string; baseline: boolean } {
  let start = 0;
  for (const [view, count] of VIEWS) {
    if (index < start + count) {
      const at = index - start;
      if (count === 1) return { view, label: `${view} drift`, baseline: true };
      return at % 2 === 0 ? { view, label: `${view} baseline ${at / 2 + 1}`, baseline: true } : { view, label: `${view} step ${(at + 1) / 2}`, baseline: false };
    }
    start += count;
  }
  return { view: "heavy", label: `heavy extra ${index}`, baseline: false };
}

/** A pass as the GL signature lists it (`gpu-frame-probe.ts`): kind and index, viewport, clears and draws. */
function passText(view: string, index: number, step: number): string {
  const kinds = ["F", "D", "S", "C", "P"];
  const size = index % 3 === 0 ? "2048x2048" : index % 3 === 1 ? "2360x1576" : "1180x788";
  return `${kinds[index % kinds.length]}${index} v0,0,${size} cds@0,0,${size} x${(index * 37 + view.length * 11 + step) % 400}`;
}

function profileRow(index: number): FeatureTestBenchmarkSample {
  const { view, label, baseline } = rowLabel(index);
  // A step changes the draws of its passes; a view's baselines share theirs.
  const step = baseline ? 0 : index;
  const structure = (variant: number, passes: number) => ({
    hash: `${view}${variant}${step}`.padEnd(8, "0").slice(0, 8), frames: variant === 0 ? 140 : 3,
    passes: Array.from({ length: passes }, (_, pass) => passText(view, pass + variant, step)),
  });
  const gpuProbe: SampledGpuProbe = {
    signature: {
      frames: 150, modal: "a1b2c3d4", modalShare: 0.93, distinct: 4, passes: 40, clears: 38, blits: 3, invalidates: 4, draws: 1210,
      texelsCleared: 41_000_000, texelsCovered: 52_000_000,
      structures: [structure(0, 40), structure(1, 40), structure(2, 41), structure(3, 39)],
    },
    shadows: { frames: 150, maps: 6, redrawn: 2, cached: 4, continuous: 1, tiles: 9, texels: 18_874_368, atlasEdge: 8192, generationFirst: 3, generationLast: 3 },
    raf: { callbacks: 120, ms: 3000, perSecond: 40 },
    serial: {
      id: index, frames: 8, frameMs: 21.4, coldMs: 30.1, cpuMs: 6.2,
      stages: (["other", "shadows", "captures", "main", "effects", "tail"] as const).map((stage, at) => ({ stage, ms: 1.5 + at, censored: at === 0, subMs: 0.8 + at / 10 })),
      syntheticMs: 4.1, syntheticColdMs: 5.2, hashes: Array.from({ length: 8 }, (_, at) => `a1b2c3d${at % 2}`), splits: 0, failed: null, ms: 420,
    },
    burst: { id: index, frames: 30, periodMs: 22.1, submitMs: 7.3, failed: null, ms: 900 },
    timers: {
      id: index, available: true, frames: 30, discarded: 1, frameMs: 20.2, cpuMs: 6.4, headStart: { ms: 12, starved: 0 },
      stages: (["other", "shadows", "captures", "main", "effects", "tail"] as const).map((stage, at) => ({ stage, ms: 1 + at, meanMs: 1.1 + at })),
      passes: Array.from({ length: 24 }, (_, at) => ({ stage: "main" as const, label: `pass ${at} ${view} render target ${at % 5}`, ms: 0.4 + at / 10, meanMs: 0.5 + at / 10, frames: 30 })),
      failed: null,
    },
  } as unknown as SampledGpuProbe;
  const settings = Object.fromEntries(Array.from({ length: 36 }, (_, at) => [`setting.field${at}`, at % 4 === 0 ? `value ${index % 3}` : `value ${at}`]));
  const passes = { objects: 420, geometry: 40, shadows: 140, captures: 90, post: 12, layers: 6, water: 18, other: 2 };
  return {
    label, baseline, view, atMs: index * 8_000,
    frames: { frames: 120, durationMs: 3000, fps: 40, medianMs: 16.7, meanMs: 25, vsync: [0.55, 0.4, 0.03, 0.02], p95Ms: 50, maxMs: 83, stalls: 0, intervals: [66, 48, 4, 2, 0] },
    runtimeFps: 40, cpuMs: 9.1, gpuMs: null, drawCalls: 1210,
    draws: { median: 1210, min: 1190, max: 1240, samples: 6 }, cpu: { median: 9.1, min: 8.2, max: 12.4, samples: 6 }, gpu: null,
    resolution: "1770x1182@1.00", backbuffer: "2360x1576", failed: [], settings,
    unsettled: { firstDraws: 0, compiling: 0, settleMs: 1100 }, switched: { ms: 900, firstDraws: 2, stalls: 0, programs: 1 },
    drawPasses: passes, drawPassMs: Object.fromEntries(Object.keys(passes).map((pass, at) => [pass, 0.3 + at / 10])),
    programs: {
      programs: 223, neverDrawn: 12, passes, materials: { builds: 180, programs: 120, adopted: 60, sameShaderRebuilds: 4 },
      shaders: 64, mostVariants: 9,
      splitBy: Array.from({ length: 10 }, (_, at) => ({ define: `DEFINE_${at}`, with: Array.from({ length: 4 }, (_, w) => `material_${at}_${w}`), shaders: 10 - at })),
    },
    presentation: { drawn: 118, held: 2, ms: 3000, heldReasons: { "shaders compiling": 1, "settings applying": 1 } },
    work: { graphBuilds: 0, shadowAdmissions: 240, shadowAdmissionMs: 1.2, strictReadinessChecks: 12, readinessProbeMs: 0.4 },
    memory: { deviceAvailableBytes: 900_000_000, appAvailableBytes: 1_200_000_000 }, inFlightPeak: 2,
    gpuBusy: { medianMs: 20.1, p95Ms: 26.3, frames: 118, pollMs: 6.2, skipped: 0 },
    framesInFlight: { mode: 2, skipped: 0 },
    shadowAtlas: { edge: 8192, maps: [{ mapSize: 2048, passes: 4 }, { mapSize: 2048, passes: 6 }, { mapSize: 1024, passes: 1 }] },
    longFrames: { ms: 3000, frames: 120, three: { render: 2 }, four: { none: 2, timer2000: 1 } },
    gpuProbe,
    ...(label.endsWith("baseline 1") ? {
      webGl: { windows: 3, frames: 40, cpuMs: 9.3, totalMs: 4.2, groups: Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`group${at}`, { ms: 0.3, calls: 40 + at }])) },
    } : {}),
  } as unknown as FeatureTestBenchmarkSample;
}
