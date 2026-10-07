import { DynamicRuntimeMeshGeometry, type DynamicMeshUpdate } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import type { Actor, ActorComponent } from "@babylonslate/object-model";
import type { RuntimeSubsystem } from "./runtime-subsystems";

const geometryByComponent = new WeakMap<ActorComponent, DynamicRuntimeMeshGeometry>();

/** Physics reads only live, worker-owned geometry, never a transferred render packet. */
export function dynamicRuntimeGeometry(component: ActorComponent): DynamicRuntimeMeshGeometry | undefined {
  return geometryByComponent.get(component);
}

type State = { meshId: number; owner: Actor | null; geometry: DynamicRuntimeMeshGeometry };
type MeshSyncHost = {
  slot: (actor: Actor) => number | undefined;
  eligible: (actor: Actor) => boolean;
  emit: (command: CommandMessage) => void;
};

/** Registered on demand; clean ticks do not walk components or geometry buffers. */
export class DynamicRuntimeMeshSync implements RuntimeSubsystem {
  private readonly states = new Map<ActorComponent, State>();
  private readonly dirty = new Set<ActorComponent>();
  private sequence = 0;
  private readonly host: MeshSyncHost;

  constructor(host: MeshSyncHost) {
    this.host = host;
  }

  private state(component: ActorComponent): State {
    let state = this.states.get(component);
    if (!state) {
      const geometry = new DynamicRuntimeMeshGeometry();
      state = { meshId: ++this.sequence, owner: component.owner, geometry };
      this.states.set(component, state);
      geometryByComponent.set(component, geometry);
    }
    return state;
  }

  assign(component: ActorComponent): { meshId: number; update: DynamicMeshUpdate } {
    const state = this.state(component);
    this.dirty.delete(component);
    return { meshId: state.meshId, update: state.geometry.takeUpdate(true) };
  }

  invoke(component: ActorComponent, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const owner = component.owner;
    if (component.classId !== "DynamicRuntimeMeshComponent" || component.destroyed || !owner || owner.destroyed ||
      !owner.components.includes(component) || !this.host.eligible(owner)) return { success: false };
    const geometry = this.state(component).geometry;
    const revision = geometry.revision;
    let success = true;
    switch (name) {
      case "setDynamicMeshGeometry": success = geometry.setGeometry(args.positions, args.indices, args.normals, args.uvs); break;
      case "updateDynamicMeshVertices": success = geometry.updateVertices(args.firstVertex ?? 0, args.positions, args.normals, args.uvs); break;
      case "clearDynamicMeshGeometry": geometry.clear(); break;
      case "recalculateDynamicMeshNormals": geometry.recalculateNormals(); break;
      case "recalculateDynamicMeshBounds": geometry.recalculateBounds(); break;
      default: return { success: false };
    }
    if (geometry.revision !== revision) this.dirty.add(component);
    return { success };
  }

  flush(): void {
    for (const component of this.dirty) {
      const owner = component.owner;
      if (component.destroyed || !owner || owner.destroyed || !owner.components.includes(component)) { this.remove(component); continue; }
      if (!this.host.eligible(owner) || this.host.slot(owner) === undefined) continue;
      const state = this.states.get(component)!;
      this.host.emit({ type: "dynamicMeshUpdate", meshId: state.meshId, update: state.geometry.takeUpdate() });
      this.dirty.delete(component);
    }
  }

  remove(component: ActorComponent): void {
    this.dirty.delete(component);
    this.states.delete(component);
    geometryByComponent.delete(component);
  }

  retireActor(actor: Actor): void {
    for (const [component, state] of this.states) if (state.owner === actor) this.remove(component);
  }

  releaseSlot(_slotId: number, owner: Actor | undefined): void {
    if (owner) this.retireActor(owner);
  }

  dispose(): void {
    for (const component of this.states.keys()) geometryByComponent.delete(component);
    this.states.clear(); this.dirty.clear();
  }
}
