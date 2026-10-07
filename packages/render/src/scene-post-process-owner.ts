import { materialParameterDefaults } from "@babylonslate/shader-graph";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import {
  normalizePostProcessStack,
  type AttachedPostProcessStack, type AttachPostProcessStackOptions,
} from "./post-process-material";
import { prepareScenePostProcessPlan, type ScenePostProcessPlan } from "./scene-post-process-plan";

export type ScenePostProcessParameters = Pick<AttachedPostProcessStack,
  "setParameter" | "getParameter" | "resetParameter">;

/** One authored owner; the prepared graph holds its GPU instances. */
export class ScenePostProcessOwner {
  readonly options: AttachPostProcessStackOptions;
  private graphParameters: ScenePostProcessParameters | undefined;
  private disposed = false;
  private resolveDisposed!: () => void;
  private readonly disposedSignal = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  private readonly replay = new Map<string, Map<string, MaterialParameterValue>>();

  constructor(options: AttachPostProcessStackOptions) {
    this.options = { ...options, stack: normalizePostProcessStack(options.stack) };
  }

  plan(): ScenePostProcessPlan {
    return prepareScenePostProcessPlan(this.options.library, this.options.stack, this.options.documentFor);
  }

  useGraph(parameters?: ScenePostProcessParameters): void {
    this.graphParameters = parameters;
    if (parameters) this.applyReplay(parameters);
  }

  setParameter(entryId: string, name: string, value: MaterialParameterValue): boolean {
    if (this.disposed) return false;
    const entry = this.options.stack.find((candidate) => candidate.id === entryId);
    const document = entry && this.options.documentFor(entry.materialGuid);
    if (!entry || !document || !this.options.library.acceptsParameter(document, name, value)) return false;
    const target = this.graphParameters;
    if (entry.enabled && target && !target.setParameter(entryId, name, value)) return false;
    // Preserve updates through graph rebuilds.
    let values = this.replay.get(entryId);
    if (!values) { values = new Map(); this.replay.set(entryId, values); }
    values.set(name, structuredClone(value));
    return true;
  }

  getParameter(entryId: string, name: string): MaterialParameterValue | null {
    if (this.disposed) return null;
    const value = this.graphParameters?.getParameter(entryId, name)
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
    if (this.disposed) return;
    this.disposed = true;
    this.graphParameters = undefined;
    this.resolveDisposed();
  }

  /** The graph that held this owner's GPU instances retires them. */
  whenDisposed(): Promise<void> { return this.disposedSignal; }

  whenReleased(): Promise<void> { return this.disposedSignal; }

  private applyReplay(target: ScenePostProcessParameters): void {
    for (const [id, values] of this.replay)
      for (const [name, value] of values) target.setParameter(id, name, value);
  }
}
