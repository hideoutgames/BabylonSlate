import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { setDrawPassStageListener } from "./draw-passes";
import { engineFrameBackpressure } from "./frame-backpressure";
import { engineFrameMarkers } from "./gpu-busy-probe";
import {
  BurstFrameProbe, type BurstProbeResult, GlSignatureRecorder, installGlSignature, messageChannelScheduler, RafCadence, SerialFrameProbe, ShadowFrameWindow,
  type GlSignatureStats, type SerialProbeResult, type ShadowFrameStats,
} from "./gpu-frame-probe";
import { GpuPassTimers, webglPassTimerHost, type PassTimerHost, type PassTimerResult } from "./gpu-pass-timers";
import { createGpuSyntheticLoad, type GpuSyntheticLoad } from "./gpu-synthetic-load";

/** What the GPU probes report (`RenderDiagnostics.gpuProbe`): the window since `gpuprobe on`, and the last serial probe. */
export interface GpuProbeSnapshot {
  /** Whether the passive probes are recording (`gpuprobe on`). */
  recording: boolean;
  signature: GlSignatureStats | null;
  shadows: ShadowFrameStats | null;
  raf: { callbacks: number; ms: number; perSecond: number } | null;
  /** The last `gpuprobe serial` result; its `id` grows with each. */
  serial: SerialProbeResult | null;
  serialRunning: boolean;
  /** The last `gpuprobe timers` result: GPU time per stage and pass from timer queries; its `id` grows with each. */
  timers: PassTimerResult | null;
  timersRunning: boolean;
  /** The last `gpuprobe burst` result: the unquantised frame period with frames queued; its `id` grows with each. */
  burst: BurstProbeResult | null;
  burstRunning: boolean;
}

/** A context without timer queries: nothing starts. */
const NO_TIMER_QUERIES: PassTimerHost<never> = {
  begin: () => null, end: () => {}, read: () => null, disjoint: () => false, release: () => {}, now: () => performance.now(),
};

type FrameCaptureEngine = AbstractEngine & { _captureGPUFrameTime?: boolean };

/** A Scene's shadow state as an Engine frame ends: the maps held, and the atlas's cumulative draws (`shadow-atlas.ts`). */
export interface ShadowProbeReading {
  maps: number;
  continuous: number;
  drawnMaps: number;
  drawnTiles: number;
  drawnTexels: number;
  atlasEdge: number;
  atlasGeneration: number;
}

/**
 * The Engine's GPU probes (`gpu-frame-probe.ts`), one per Engine: its GL context and GPU queue are shared by every view.
 * Nothing is installed until the first `gpuprobe` command, and `off` takes the GL wrappers off the context again.
 */
export class EngineGpuProbe {
  private readonly engine: AbstractEngine;
  private readonly recorder = new GlSignatureRecorder();
  private readonly shadowWindow = new ShadowFrameWindow();
  private readonly raf = new RafCadence();
  private readonly scheduler = messageChannelScheduler();
  private readonly synthetic: GpuSyntheticLoad;
  private readonly serialProbe: SerialFrameProbe;
  private readonly burstProbe: BurstFrameProbe;
  /** The frames-in-flight limit a burst lifted, restored as it ends. */
  private burstPaced: ReturnType<typeof engineFrameBackpressure>["mode"] | null = null;
  private readonly timers: GpuPassTimers<unknown>;
  private readonly timersAvailable: boolean;
  private readonly headLoad: GpuSyntheticLoad;
  /** The head start's target is held: released as the run ends, so no target outlives it. */
  private headLoaded = false;
  /** Babylon's frame-wide GPU timer was on as the pass timers started: it is off while they record, back on after. */
  private captureSuspended = false;
  private uninstall: (() => void) | null = null;
  private shadowSource: (() => ShadowProbeReading | null) | null = null;
  private shadowBefore: ShadowProbeReading | null = null;
  private listening = false;
  /** Stage fences waiting for the next pass to start (`SerialProbeHost.deferFence`). */
  private readonly deferred: (() => void)[] = [];

  constructor(engine: AbstractEngine) {
    this.engine = engine;
    this.synthetic = createGpuSyntheticLoad(engine);
    const markers = engineFrameMarkers(engine);
    this.serialProbe = new SerialFrameProbe({
      fence: () => {
        const marker = markers?.(performance.now()) ?? null;
        if (marker) this.recorder.fence();
        return marker;
      },
      now: () => performance.now(),
      schedule: (callback) => this.scheduler.schedule(callback),
      drained: () => engineFrameBackpressure(engine).stats().inFlight === 0,
      synthetic: { ready: () => this.synthetic.ready(), draw: () => this.synthetic.draw() },
      frameHash: () => this.uninstall ? this.recorder.lastHash : null,
      fenceSplits: () => this.recorder.fenceSplits,
      // Only the recorder knows where a pass starts: without it a stage is fenced where it ends.
      deferFence: (submit) => {
        if (this.uninstall) this.deferred.push(submit);
        else submit();
      },
    });
    this.recorder.onPassStart = () => this.submitDeferred();
    this.burstProbe = new BurstFrameProbe({
      fence: () => markers?.(performance.now()) ?? null,
      now: () => performance.now(),
      schedule: (callback) => this.scheduler.schedule(callback),
      unpace: (on) => {
        const backpressure = engineFrameBackpressure(engine);
        if (on) {
          this.burstPaced ??= backpressure.mode;
          backpressure.setMode("off");
        } else if (this.burstPaced !== null) {
          backpressure.setMode(this.burstPaced);
          this.burstPaced = null;
        }
      },
    });
    const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
    // The head start: the synthetic load's program in a load of its own, which the timers draw before each frame.
    this.headLoad = createGpuSyntheticLoad(engine);
    const timerHost = gl && (engine as unknown as { webGLVersion?: number }).webGLVersion === 2
      ? webglPassTimerHost(gl, () => {
        this.headLoaded = true;
        if (this.headLoad.ready()) this.headLoad.draw();
      })
      : null;
    this.timersAvailable = timerHost !== null;
    this.timers = new GpuPassTimers<unknown>((timerHost ?? NO_TIMER_QUERIES) as PassTimerHost<unknown>);
    const begin = engine.onBeginFrameObservable.add(() => {
      this.serialProbe.expire();
      if (this.uninstall) this.recorder.beginFrame();
    });
    // First of the frame's begin observers: Babylon's frame timer is taken off before its own observer starts a query.
    const timerBegin = engine.onBeginFrameObservable.add(() => {
      if (!this.timers.running) return;
      this.suspendFrameCapture();
      // Results of earlier frames, and the run's time bound, while no view renders.
      this.timers.poll();
    }, undefined, true);
    const end = engine.onEndFrameObservable.add(() => this.frameEnd());
    engine.onDisposeObservable.addOnce(() => {
      engine.onBeginFrameObservable.remove(begin);
      engine.onBeginFrameObservable.remove(timerBegin);
      engine.onEndFrameObservable.remove(end);
      this.off();
      this.synthetic.dispose();
      this.headLoad.dispose();
      this.scheduler.dispose();
    });
  }

  /** The view whose Scene's shadow maps the shadow counters read: the one the `gpuprobe` command reached. */
  setShadowSource(source: () => ShadowProbeReading | null): void {
    this.shadowSource = source;
  }

  /** `gpuprobe on`: starts (restarts) the passive window. */
  on(): void {
    const gl = (this.engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
    if (!this.uninstall && gl && (this.engine as unknown as { webGLVersion?: number }).webGLVersion === 2)
      this.uninstall = installGlSignature(gl, this.recorder);
    this.recorder.start();
    this.shadowWindow.start();
    this.shadowBefore = this.shadowSource?.() ?? null;
    this.raf.start();
  }

  /**
   * `gpuprobe off`: stops everything, restores the context's own calls and releases the synthetic load's target; the
   * last results stay readable.
   */
  off(): void {
    this.burstProbe.dispose();
    this.timers.stop();
    this.headLoad.release();
    this.restoreFrameCapture();
    this.serialProbe.dispose();
    this.deferred.length = 0;
    this.synthetic.release();
    this.listen(false);
    this.raf.stop();
    this.uninstall?.();
    this.uninstall = null;
  }

  /** `gpuprobe serial`: false while one runs or without fences. */
  serial(): boolean {
    return this.serialProbe.request();
  }

  /**
   * `gpuprobe timers`: GPU time per stage and pass over the next `PASS_TIMER_FRAMES` frames, from timer queries; false
   * while a run records. Without timer queries the run ends at once, reporting them absent.
   */
  /** `gpuprobe burst`: the frame period over the next frames with the frames-in-flight limit lifted; false while one runs. */
  burst(): boolean {
    return this.burstProbe.request();
  }

  passTimers(): boolean {
    return this.timers.start(this.timersAvailable);
  }

  /** Whether no view may render now (`SerialFrameProbe.holding`). */
  get holding(): boolean { return this.serialProbe.holding; }

  /** A view is about to render in this Engine frame. */
  frameStarted(): void {
    // The pass timers time only Engine frames a view renders in, from its start: a frame the backpressure or the
    // scheduler skipped submits nothing to time, and its head start would only slow the frames that render.
    if (this.timers.running && !this.timers.inFrame) this.timers.frameBegin();
    if (this.serialProbe.running) this.serialProbe.frameStarted();
    this.listen(this.serialProbe.inFrame || this.timers.inFrame);
  }

  /** A view drew its frame whole. */
  frameDrawn(): void { this.serialProbe.frameDrawn(); }

  snapshot(): GpuProbeSnapshot {
    return {
      recording: this.uninstall !== null,
      signature: this.recorder.stats(), shadows: this.shadowWindow.stats(), raf: this.raf.stats(),
      serial: this.serialProbe.result(), serialRunning: this.serialProbe.running,
      timers: this.timers.result(), timersRunning: this.timers.running,
      burst: this.burstProbe.result(), burstRunning: this.burstProbe.active,
    };
  }

  private frameEnd(): void {
    this.timers.frameEnd();
    if (!this.timers.running) {
      this.restoreFrameCapture();
      if (this.headLoaded) {
        this.headLoaded = false;
        this.headLoad.release();
      }
    }
    if (this.uninstall && this.recorder.endFrame()) {
      const now = this.shadowSource?.() ?? null;
      const before = this.shadowBefore;
      if (now) {
        this.shadowWindow.add({
          maps: now.maps, continuous: now.continuous,
          redrawn: before ? now.drawnMaps - before.drawnMaps : 0, tiles: before ? now.drawnTiles - before.drawnTiles : 0,
          texels: before ? now.drawnTexels - before.drawnTexels : 0, atlasEdge: now.atlasEdge, atlasGeneration: now.atlasGeneration,
        });
        this.shadowBefore = now;
      }
    }
    this.listen(false);
    // The frame's work is all submitted: the fences still waiting for a pass to start go first, in order.
    this.submitDeferred();
    this.serialProbe.frameEnded();
    this.burstProbe.frameEnded(engineFrameBackpressure(this.engine).renderedThisFrame());
  }

  private submitDeferred(): void {
    if (!this.deferred.length) return;
    for (const submit of this.deferred.splice(0)) submit();
  }

  /** Draw pass boundaries are told only while a serialised frame renders or the pass timers record one. */
  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    setDrawPassStageListener(on ? (pass, label) => {
      this.serialProbe.stageBoundary(pass);
      this.timers.boundary(pass, label);
    } : null);
  }

  /**
   * Only one elapsed-time query can run at a time: Babylon's frame-wide one (Play's renderer timing,
   * `engine-gpu-timing.ts`) is off while the pass timers record, its counter keeping its last value.
   */
  private suspendFrameCapture(): void {
    const engine = this.engine as FrameCaptureEngine;
    if (engine._captureGPUFrameTime !== true) return;
    engine.captureGPUFrameTime(false);
    this.captureSuspended = true;
  }

  private restoreFrameCapture(): void {
    if (!this.captureSuspended) return;
    this.captureSuspended = false;
    if (!this.engine.isDisposed) this.engine.captureGPUFrameTime(true);
  }
}

const probes = new WeakMap<AbstractEngine, EngineGpuProbe>();

/** The Engine's GPU probes, made at the first call. */
export function engineGpuProbe(engine: AbstractEngine): EngineGpuProbe {
  let probe = probes.get(engine);
  if (!probe) probes.set(engine, probe = new EngineGpuProbe(engine));
  return probe;
}

/** The Engine's GPU probes if a `gpuprobe` command ever made them. */
export function existingGpuProbe(engine: AbstractEngine): EngineGpuProbe | null {
  return probes.get(engine) ?? null;
}
