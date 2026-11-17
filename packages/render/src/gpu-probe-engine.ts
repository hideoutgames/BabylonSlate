import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { setDrawPassStageListener } from "./draw-passes";
import { engineFrameBackpressure } from "./frame-backpressure";
import { engineFrameMarkers } from "./gpu-busy-probe";
import {
  GlSignatureRecorder, installGlSignature, messageChannelScheduler, RafCadence, SerialFrameProbe, ShadowFrameWindow,
  type GlSignatureStats, type SerialProbeResult, type ShadowFrameStats,
} from "./gpu-frame-probe";
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
}

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
    const begin = engine.onBeginFrameObservable.add(() => {
      this.serialProbe.expire();
      if (this.uninstall) this.recorder.beginFrame();
    });
    const end = engine.onEndFrameObservable.add(() => this.frameEnd());
    engine.onDisposeObservable.addOnce(() => {
      engine.onBeginFrameObservable.remove(begin);
      engine.onEndFrameObservable.remove(end);
      this.off();
      this.synthetic.dispose();
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

  /** Whether no view may render now (`SerialFrameProbe.holding`). */
  get holding(): boolean { return this.serialProbe.holding; }

  /** A view is about to render in this Engine frame. */
  frameStarted(): void {
    if (!this.serialProbe.running) return;
    this.serialProbe.frameStarted();
    this.listen(this.serialProbe.inFrame);
  }

  /** A view drew its frame whole. */
  frameDrawn(): void { this.serialProbe.frameDrawn(); }

  snapshot(): GpuProbeSnapshot {
    return {
      recording: this.uninstall !== null,
      signature: this.recorder.stats(), shadows: this.shadowWindow.stats(), raf: this.raf.stats(),
      serial: this.serialProbe.result(), serialRunning: this.serialProbe.running,
    };
  }

  private frameEnd(): void {
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
  }

  private submitDeferred(): void {
    if (!this.deferred.length) return;
    for (const submit of this.deferred.splice(0)) submit();
  }

  /** Draw pass boundaries are stage boundaries only while a serialised frame renders. */
  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    setDrawPassStageListener(on ? (pass) => this.serialProbe.stageBoundary(pass) : null);
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
