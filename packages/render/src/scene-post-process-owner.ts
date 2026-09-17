import { PostProcessRetirement } from "./post-process-retirement";
import { materialParameterDefaults } from "@babylonslate/shader-graph";
import type { Camera } from "@babylonjs/core";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import {
  attachPostProcessStack, normalizePostProcessStack,
  type AttachedPostProcessStack, type AttachPostProcessStackOptions,
} from "./post-process-material";
import { prepareScenePostProcessPlan, type ScenePostProcessPlan } from "./scene-post-process-plan";

export type ScenePostProcessParameters = Pick<AttachedPostProcessStack,
  "setParameter" | "getParameter" | "resetParameter">;

/** One authored owner, with mutually exclusive graph and native GPU instances. */
export class ScenePostProcessOwner {
  readonly options: AttachPostProcessStackOptions;
  private native: AttachedPostProcessStack | undefined;
  private nativeCamera: Camera | undefined;
  private graphParameters: ScenePostProcessParameters | undefined;
  private disposed = false;
  private cleanupFailure: unknown;
  private readonly retirement = new PostProcessRetirement();
  private resolveDisposed!: () => void;
  private readonly disposedSignal = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  private readonly replay = new Map<string, Map<string, MaterialParameterValue>>();

  constructor(options: AttachPostProcessStackOptions) {
    this.options = { ...options, stack: normalizePostProcessStack(options.stack) };
  }

  nativeReadyFor(camera: Camera): boolean { return !this.disposed && this.nativeCamera === camera; }

  get passes() { return this.native?.passes ?? []; }
  get hasEnabledEntries(): boolean { return this.options.stack.some((entry) => entry.enabled); }

  plan(): ScenePostProcessPlan {
    return prepareScenePostProcessPlan(this.options.library, this.options.stack, this.options.documentFor);
  }

  /** The graph owner releases its resources before selecting the native path. */
  useNative(camera: Camera): void {
    if (this.disposed || this.nativeCamera === camera) return;
    this.detachNative();
    this.graphParameters = undefined;
    this.nativeCamera = camera;
    if (!this.hasEnabledEntries) return;
    this.native = attachPostProcessStack({ ...this.options, camera });
    this.applyReplay(this.native);
  }

  /** No native pass may apply again after the graph has processed scene color. */
  useGraph(parameters?: ScenePostProcessParameters): void {
    this.detachNative();
    this.graphParameters = parameters;
    if (parameters) this.applyReplay(parameters);
  }

  setParameter(entryId: string, name: string, value: MaterialParameterValue): boolean {
    if (this.disposed) return false;
    const entry = this.options.stack.find((candidate) => candidate.id === entryId);
    const document = entry && this.options.documentFor(entry.materialGuid);
    if (!entry || !document || !this.options.library.acceptsParameter(document, name, value)) return false;
    const target = this.native ?? this.graphParameters;
    if (entry.enabled && target && !target.setParameter(entryId, name, value)) return false;
    // Preserve updates through graph resize and native fallback transitions.
    let values = this.replay.get(entryId);
    if (!values) { values = new Map(); this.replay.set(entryId, values); }
    values.set(name, structuredClone(value));
    return true;
  }

  getParameter(entryId: string, name: string): MaterialParameterValue | null {
    if (this.disposed) return null;
    const target = this.native ?? this.graphParameters;
    const value = target?.getParameter(entryId, name)
      ?? this.replay.get(entryId)?.get(name)
      ?? this.resetValue(entryId, name);
    return value ? structuredClone(value) : null;
  }

  resetParameter(entryId: string, name: string): boolean {
    if (this.disposed) return false;
    const value = this.resetValue(entryId, name);
    return !!value && this.setParameter(entryId, name, value);
  }

  private resetValue(entryId: string, name: string): MaterialParameterValue | null {
    const entry = this.options.stack.find((candidate) => candidate.id === entryId);
    const document = entry && this.options.documentFor(entry.materialGuid);
    if (!entry || !document) return null;
    const lowered = this.options.library.planFor(document);
    if (lowered.ok === false) return null;
    const compiled = materialParameterDefaults(lowered.plan)[name];
    if (!compiled) return null;
    const authored = entry.parameters?.[name];
    for (const value of [authored, compiled])
      if (value && this.options.library.acceptsParameter(document, name, value)) return structuredClone(value);
    return null;
  }

  clearGraph(): void { this.graphParameters = undefined; }

  dispose(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.disposed) return;
    this.disposed = true;
    try { this.detachNative(); }
    finally { this.graphParameters = undefined; this.resolveDisposed(); }
  }

  async whenDisposed(): Promise<void> {
    await this.disposedSignal;
    if (this.cleanupFailure) throw this.cleanupFailure;
    await this.retirement.whenDisposed();
  }

  async whenReleased(): Promise<void> {
    await this.disposedSignal;
    if (this.cleanupFailure) throw this.cleanupFailure;
    await this.retirement.whenReleased();
  }

  private applyReplay(target: ScenePostProcessParameters): void {
    for (const [id, values] of this.replay)
      for (const [name, value] of values) target.setParameter(id, name, value);
  }

  private detachNative(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    try {
      if (this.native) {
        this.native.dispose();
        this.retirement.add(this.native);
      }
    }
    catch (error) { this.cleanupFailure = error; throw error; }
    this.native = undefined;
    this.nativeCamera = undefined;
  }
}
