import type { AbstractEngine, Scene } from "@babylonjs/core";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { IFrameGraphPass } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";

export interface RenderFrameStageDescription {
  name: string;
  kind: "frameGraph" | "task" | "native" | "overlay" | "composition" | "auxiliary";
  sceneId?: string;
  actorGuid?: string;
  materialGuid?: string;
  detail?: string;
}
export interface RenderFrameStage extends RenderFrameStageDescription {
  id: number;
  parentId?: number;
  sceneUniqueId: number;
  graphId?: number;
  taskId?: number;
  startedAtMs: number;
  /** Inclusive submission wall time, including nested stages and driver waits. */
  submissionMs?: number;
  drawCalls?: number;
  completed: boolean;
  fallbackPasses?: boolean;
  /** Selected enabled passes, not independently timed pass observations. */
  selectedPasses?: string[];
}
export interface RenderFramePassDescription {
  name: string;
  disabled: boolean;
  colorTargets?: number[];
  depthTarget?: number;
}
export interface RenderFrameTaskDescription {
  id: number;
  graphId: number;
  name: string;
  type: string;
  disabled: boolean;
  passes: RenderFramePassDescription[];
  disabledPasses: RenderFramePassDescription[];
  dependencies: number[];
}
export interface RenderFrameResource {
  graphId: number;
  handle: number;
  width?: number;
  height?: number;
  samples?: number;
  formats?: number[];
  types?: number[];
  labels?: string[];
  unavailable?: string;
}
export interface RenderFrameReportDraft {
  version: 1;
  graphs: { id: number; sceneUniqueId: number; generation: number }[];
  tasks: RenderFrameTaskDescription[];
  /** Actual observed execution order; descriptions alone do not imply execution. */
  stages: RenderFrameStage[];
  resources: RenderFrameResource[];
  complete: boolean;
  droppedRecords: number;
  /** Admission accounting for retained serialized records, not a browser heap cap. */
  retainedBytes: number;
  byteBudget: number;
  limitations: string[];
}

export interface RenderFrameReport extends RenderFrameReportDraft {
  frame: {
    renderFrameId: number;
    snapshotFrameId: number;
    tickId: number;
    sceneGeneration: number;
    sceneLoadId?: number;
    sceneAssetGuid?: string;
    viewId: number;
    width: number;
    height: number;
    backend: "webgpu" | "webgl2" | "webgl1" | "unknown";
  };
}

export type RenderFrameReportReceipt = { lease: number; report: RenderFrameReport };

/** One finite request per view. Only the owning host's successful visible copy
 * may complete it; a held draw is never a report. */
export class RenderFrameReportFeed {
  private lease = 0;
  private request: {
    lease: number; generation: number; resolve: (report: RenderFrameReport) => void;
    reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>;
  } | undefined;
  get active(): boolean { return this.request !== undefined; }
  arm(generation: number): Promise<RenderFrameReport> {
    if (this.request) return Promise.reject(new Error("A frame capture is already pending."));
    const lease = ++this.lease;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.request?.lease === lease) this.cancel("No coherent game frame was presented before the capture deadline.");
      }, 10_000);
      this.request = { lease, generation, resolve, reject, timer };
    });
  }
  candidate(report: RenderFrameReport): RenderFrameReportReceipt | null {
    return this.request && this.request.generation === report.frame.sceneGeneration
      ? { lease: this.request.lease, report } : null;
  }
  complete(receipt: RenderFrameReportReceipt | null, generation: number): void {
    const request = this.request;
    if (!request || !receipt || receipt.lease !== request.lease) return;
    if (generation !== request.generation || receipt.report.frame.sceneGeneration !== generation) {
      this.cancel("The scene changed before the captured frame was presented."); return;
    }
    this.request = undefined;
    clearTimeout(request.timer);
    request.resolve(receipt.report);
  }
  cancel(reason = "Frame capture was cancelled."): void {
    const request = this.request;
    if (!request) return;
    this.request = undefined;
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
}

const MAX_RECORDS = 256;
const MAX_GRAPHS = 16;
const MAX_PASSES = 32;
const MAX_REFERENCES = 64;
const BYTE_BUDGET = 256 * 1024;
const text = (value: string) => value.slice(0, 160);
let active: RenderFrameCapture | undefined;

/** Only the explicitly requested synchronous game draw owns this scope. A
 * shared Engine's unrelated later views cannot join it. No listeners survive it. */
export function captureRenderFrame<T>(engine: AbstractEngine, draw: () => T): { value: T; report: RenderFrameReportDraft } {
  const scope = beginRenderFrameCapture(engine);
  try { return { value: draw(), report: scope.capture.report }; }
  finally { scope.dispose(); }
}

/** The owner must close this scope in the same synchronous turn, in finally. */
export function beginRenderFrameCapture(engine: AbstractEngine): { capture: RenderFrameCapture; dispose: () => void } {
  if (active) throw new Error("A frame report is already being collected.");
  const capture = new RenderFrameCapture(engine);
  active = capture;
  return { capture, dispose: () => { if (active === capture) active = undefined; } };
}

/** Callers branch before constructing descriptors/callbacks on ordinary frames. */
export function activeRenderFrameCapture(engine: AbstractEngine): RenderFrameCapture | undefined {
  return active?.engine === engine ? active : undefined;
}

export class RenderFrameCapture {
  readonly report: RenderFrameReportDraft = {
    version: 1, graphs: [], tasks: [], stages: [], resources: [], complete: true,
    droppedRecords: 0, retainedBytes: 1024, byteBudget: BYTE_BUDGET,
    limitations: [
      "Submission durations are inclusive wall time and may include driver waits; nested rows must not be added together.",
      "GPU timing and per-pass execution timing are unavailable. Task pass lists describe the selected public pass branch.",
      "Texture handles identify resources within their graph; allocation aliasing remains enabled. No texture pixels are retained.",
      "Actor/material attribution is present only where an owning renderer supplies it; batched draws are not attributed by inference.",
    ],
  };
  private readonly started = performance.now();
  private readonly parents: number[] = [];
  private readonly encoder = new TextEncoder();

  readonly engine: AbstractEngine;
  constructor(engine: AbstractEngine) { this.engine = engine; }

  stage<T>(scene: Scene, description: RenderFrameStageDescription, draw: () => T): T {
    const row = this.begin(scene, description);
    const calls = this.drawCalls();
    try {
      const value = draw();
      if (row) row.completed = true;
      return value;
    } finally { this.end(row, calls); }
  }

  frameGraph<T>(scene: Scene, graph: FrameGraph, generation: number, draw: () => T): T {
    if (this.report.graphs.length >= MAX_GRAPHS) { this.drop(); return draw(); }
    const graphId = this.report.graphs.length;
    const graphRow = { id: graphId, sceneUniqueId: scene.uniqueId, generation };
    if (!this.admit(graphRow)) return draw();
    this.report.graphs.push(graphRow);
    const detach: (() => void)[] = [];
    const resources = new Set<number>();
    try {
      for (const task of graph.tasks) {
        if (this.report.tasks.length >= MAX_RECORDS) { this.drop(); continue; }
        const taskId = this.report.tasks.length;
        const descriptor: RenderFrameTaskDescription = {
          id: taskId, graphId, name: text(task.name), type: text(task.getClassName()), disabled: task.disabled,
          passes: this.passes(task.passes, resources), disabledPasses: this.passes(task.passesDisabled, resources),
          dependencies: this.references(task.dependencies ?? [], resources),
        };
        if (!this.admit(descriptor)) continue;
        this.report.tasks.push(descriptor);
        let row: RenderFrameStage | undefined;
        let calls: number | undefined;
        const before = task.onBeforeTaskExecute.add(() => {
          const fallback = task.disabled && task.passesDisabled.length > 0;
          const selected = (fallback ? task.passesDisabled : task.passes).slice(0, MAX_PASSES)
            .filter((pass) => !pass.disabled).map((pass) => text(pass.name));
          row = this.begin(scene, { name: descriptor.name, kind: "task" },
            this.encoder.encode(JSON.stringify(selected)).byteLength + 256);
          calls = this.drawCalls();
          if (row) {
            row.graphId = graphId;
            row.taskId = taskId;
            row.fallbackPasses = fallback;
            row.selectedPasses = selected;
          }
        });
        const after = task.onAfterTaskExecute.add(() => {
          if (row) row.completed = true;
          this.end(row, calls);
          row = undefined;
        });
        detach.push(() => {
          task.onBeforeTaskExecute.remove(before);
          task.onAfterTaskExecute.remove(after);
          // Babylon does not emit onAfterTaskExecute when a pass throws.
          if (row) { this.end(row, calls); row = undefined; }
        });
      }
      for (const handle of resources) this.resource(graph, graphId, handle);
      return this.stage(scene, { name: "FrameGraph submission", kind: "frameGraph" }, draw);
    } finally { for (const remove of detach.reverse()) remove(); }
  }

  private begin(scene: Scene, description: RenderFrameStageDescription, reserve = 128): RenderFrameStage | undefined {
    if (this.report.stages.length >= MAX_RECORDS) { this.drop(); return undefined; }
    const row: RenderFrameStage = {
      ...description, name: text(description.name),
      ...(description.detail ? { detail: text(description.detail) } : {}),
      ...(description.sceneId ? { sceneId: text(description.sceneId) } : {}),
      ...(description.actorGuid ? { actorGuid: text(description.actorGuid) } : {}),
      ...(description.materialGuid ? { materialGuid: text(description.materialGuid) } : {}),
      id: this.report.stages.length, sceneUniqueId: scene.uniqueId,
      ...(this.parents.length ? { parentId: this.parents[this.parents.length - 1] } : {}),
      startedAtMs: performance.now() - this.started, completed: false,
    };
    // Reserve fields added when this measured stage completes.
    if (!this.admit(row, reserve)) return undefined;
    this.report.stages.push(row);
    this.parents.push(row.id);
    return row;
  }

  private end(row: RenderFrameStage | undefined, calls: number | undefined): void {
    if (!row) return;
    row.submissionMs = Math.max(0, performance.now() - this.started - row.startedAtMs);
    const after = this.drawCalls();
    if (calls !== undefined && after !== undefined && after >= calls) row.drawCalls = after - calls;
    // Remove by identity: exceptional nested task teardown may be out of order.
    const index = this.parents.lastIndexOf(row.id);
    if (index >= 0) this.parents.splice(index, 1);
  }

  private drawCalls(): number | undefined {
    const engine = this.engine as AbstractEngine & { _drawCalls?: { current: number }; drawCalls?: number };
    const value = engine._drawCalls?.current ?? engine.drawCalls;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private references(values: Iterable<number>, resources: Set<number>): number[] {
    const result: number[] = [];
    for (const handle of values) {
      if (result.length >= MAX_REFERENCES || resources.size >= MAX_RECORDS && !resources.has(handle)) { this.drop(); break; }
      result.push(handle); resources.add(handle);
    }
    return result;
  }

  private passes(passes: readonly IFrameGraphPass[], resources: Set<number>): RenderFramePassDescription[] {
    if (passes.length > MAX_PASSES) this.drop(passes.length - MAX_PASSES);
    return passes.slice(0, MAX_PASSES).map((pass) => {
      const row: RenderFramePassDescription = { name: text(pass.name), disabled: pass.disabled };
      if (FrameGraphRenderPass.IsRenderPass(pass)) {
        const target = pass.renderTarget;
        if (target !== undefined) row.colorTargets = this.references(Array.isArray(target) ? target : [target], resources);
        if (pass.renderTargetDepth !== undefined) {
          const depth = this.references([pass.renderTargetDepth], resources)[0];
          if (depth !== undefined) row.depthTarget = depth;
        }
      }
      return row;
    });
  }

  private resource(graph: FrameGraph, graphId: number, handle: number): void {
    if (this.report.resources.length >= MAX_RECORDS) { this.drop(); return; }
    let row: RenderFrameResource;
    try {
      const value = graph.textureManager.getTextureDescription(handle);
      row = { graphId, handle, width: value.size.width, height: value.size.height,
        ...(value.options.samples !== undefined ? { samples: value.options.samples } : {}),
        ...(value.options.formats ? { formats: value.options.formats.slice(0, MAX_REFERENCES) } : {}),
        ...(value.options.types ? { types: value.options.types.slice(0, MAX_REFERENCES) } : {}),
        ...(value.options.labels ? { labels: value.options.labels.slice(0, MAX_REFERENCES).map(text) } : {}),
      };
    } catch { row = { graphId, handle, unavailable: "The public texture description is unavailable for this handle." }; }
    if (this.admit(row)) this.report.resources.push(row);
  }

  private admit(value: object, reserve = 0): boolean {
    const bytes = this.encoder.encode(JSON.stringify(value)).byteLength + reserve + 1;
    if (this.report.retainedBytes + bytes > this.report.byteBudget) { this.drop(); return false; }
    this.report.retainedBytes += bytes;
    return true;
  }

  private drop(count = 1): void { this.report.complete = false; this.report.droppedRecords += count; }
}
