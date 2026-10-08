import type { CommandMessage } from "@babylonslate/bridge";
import {
  isUIControl2DClass,
  parseOverlayVisualStyle,
  supportsOverlayVisualStyle,
  type MaterialParameterValue,
} from "@babylonslate/core";
import {
  MaterialObject,
  PostProcessMaterialObject,
  SceneLayer,
  type ActorComponent,
  type MaterialInstanceObject,
  type World,
} from "@babylonslate/object-model";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import type { OwnerAdmission } from "./owner-admission";
import type { RagdollWorldSync } from "./ragdoll-sync";
import type { RenderCommandEmitter } from "./render-command-emitter";
import type { RenderSlots } from "./render-slots";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";
import type { RuntimeNavigation } from "./runtime-navigation";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { SceneLayers } from "./scene-layers";
import type { SceneRealizer } from "./scene-realizer";
import type { SimulationSession } from "./simulation-session";
import type { Text2DAppearRuntime } from "./text2d-appear-runtime";
import type { TickPipeline } from "./tick-pipeline";
import type { UIControls2DRuntime } from "./ui-controls2d-runtime";

interface RuntimePropertyWritesOptions {
  /** A loaded material parameter catalog also validates mesh material writes. */
  validateLegacyMeshParameters: boolean;
}

interface RuntimePropertyWritesHost {
  world(): World;
  simulation(): Pick<SimulationSession, "canEditActor">;
  materialParameters(): Pick<RuntimeMaterialParameters, "accepts" | "set">;
  renderSlots(): Pick<RenderSlots, "recordedSlot">;
  renderEmitter(): Pick<RenderCommandEmitter,
    "rendersComponent" | "queueDeformers" | "emitActorDeformers" | "emitMaterialAssignments" |
    "emitRenderTargetCapture" | "emitActorOutlines" | "emitActorFogVolumes" | "emitComponentTransforms" | "emitMeshAssignment">;
  uiControls(): Pick<UIControls2DRuntime, "refresh">;
  overlay(): Pick<SceneLayerOverlay, "applyLayouts" | "refreshComponent">;
  textAppear(): Pick<Text2DAppearRuntime, "refresh">;
  /** Deformer changes made during a tick are sent after it. */
  ticks(): Pick<TickPipeline, "processing">;
  audioParticles(): Pick<AudioParticleEmitter, "emitParticles" | "emitVoiceGain">;
  navigation(): Pick<RuntimeNavigation, "updateAgentParams">;
  physics(): Pick<RuntimePhysicsWorlds, "forActor">;
  ragdolls(): Pick<RagdollWorldSync, "sync">;
  layers(): Pick<SceneLayers, "get">;
  sceneRealizer(): Pick<SceneRealizer, "loadId">;
  emit(command: CommandMessage): void;
}

/**
 * The side effects of a component property or material parameter write, on
 * the script path and the runtime Inspector path alike: `refreshComponent`
 * re-sends what a written component property changes (UI control and overlay
 * layout, overlay visual style, text reveal, deformers, material and mesh
 * assignments, capture, outlines, fog, component transforms, particles, voice
 * gain, Nav Agent parameters, physics), and `setMaterialParameter` validates
 * and sends a mesh or post-process material parameter, then records it. It
 * decides which commands a write needs; `RenderCommandEmitter` builds the
 * render ones. It holds no state and is not a registered subsystem.
 */
export class RuntimePropertyWrites {
  private readonly admission: OwnerAdmission;
  private readonly validateLegacyMeshParameters: boolean;
  private readonly host: RuntimePropertyWritesHost;

  constructor(admission: OwnerAdmission, options: RuntimePropertyWritesOptions, host: RuntimePropertyWritesHost) {
    this.admission = admission;
    this.validateLegacyMeshParameters = options.validateLegacyMeshParameters;
    this.host = host;
  }

  refreshComponent(component: ActorComponent, propertyName?: string): void {
    const owner = component.owner;
    if (!owner || owner.destroyed) return;
    if (isUIControl2DClass(component.classId)) {
      this.host.uiControls().refresh(component);
      if (owner.sceneLayerId) this.host.overlay().applyLayouts();
      return;
    }
    if ((propertyName === "opacity" || propertyName === "tint") && supportsOverlayVisualStyle(component.classId)) {
      const slotId = this.host.renderSlots().recordedSlot(owner);
      if (slotId !== undefined) this.host.emit({ type: "setOverlayVisualStyle", slotId, componentId: component.guid,
        style: parseOverlayVisualStyle(Object.fromEntries(component.variables)) });
      return;
    }
    if (component.classId === "2DRichTextComponent") this.host.textAppear().refresh(component);
    if (this.host.overlay().refreshComponent(owner, component, propertyName)) return;
    // Steering/tuning is consumed by the next motor tick; only dimensions
    // need immediate collider/query refresh after a property write.
    if (component.classId === "MovementComponent" && propertyName && propertyName !== "radius" && propertyName !== "height") return;
    const slotId = this.host.renderSlots().recordedSlot(owner);
    const renderEmitter = this.host.renderEmitter();
    if (component.classId === "DeformerComponent") {
      if (slotId !== undefined) {
        if (this.host.ticks().processing) renderEmitter.queueDeformers(owner);
        else renderEmitter.emitActorDeformers(owner, slotId);
      }
      return;
    }
    if (component.classId === "MeshComponent" && propertyName === "materialGuid") {
      // A staged material belongs to this existing native mesh. Re-emitting the
      // mesh assignment here would replace that owner between prepare/commit.
      if (slotId !== undefined) renderEmitter.emitMaterialAssignments([component], slotId, true);
      return;
    }
    if (component.classId === "DynamicRuntimeMeshComponent" &&
      (propertyName === "materialGuid" || propertyName === "enableCollision" || propertyName === "layer" || propertyName === "mask")) {
      if (propertyName === "materialGuid" && slotId !== undefined) renderEmitter.emitMaterialAssignments([component], slotId, true);
      // Geometry collision changes are coalesced by the next physics step.
      return;
    }
    if (slotId !== undefined) {
      if (component.classId === "RenderTargetCaptureComponent") renderEmitter.emitRenderTargetCapture(owner, slotId);
      else if (component.classId === "OutlineComponent") renderEmitter.emitActorOutlines(owner, slotId);
      else if (component.classId === "FogVolumeComponent") renderEmitter.emitActorFogVolumes(owner, slotId);
      else if (propertyName === "transform") renderEmitter.emitComponentTransforms(owner, slotId);
      else if (component.classId !== "PhysicsConstraintComponent" && component.classId !== "RagdollComponent" && component.classId !== "MovementComponent") renderEmitter.emitMeshAssignment(owner, slotId);
    }
    if (component.classId === "ParticleComponent") {
      this.host.audioParticles().emitParticles(owner);
    }
    if (component.classId === "AudioComponent") {
      this.host.audioParticles().emitVoiceGain(component);
    }
    if (component.classId === "NavAgentComponent") {
      this.host.navigation().updateAgentParams(owner);
    }
    const sync = this.host.physics().forActor(owner);
    if (!sync) return;
    if (component.classId === "RagdollComponent" || component.classId === "MeshComponent") {
      // Ragdoll and mesh-collision edits can create or retire the owner's
      // body; reconcile that one actor from its own chain.
      this.host.ragdolls().sync();
      sync.syncActor(owner, this.host.world());
    } else sync.applyComponent(component);
  }

  /**
   * Scripts pass owner admission; the Inspector path (`inspector`) instead
   * needs a mesh material whose owner Simulate allows live edits on.
   */
  setMaterialParameter(material: MaterialInstanceObject, parameterName: string, parameter: MaterialParameterValue, inspector = false): boolean {
    if (inspector ? !(material instanceof MaterialObject) || !material.component.owner || !this.host.simulation().canEditActor(material.component.owner) : !this.admission.canRun(material)) return false;
    const validated = this.host.materialParameters().accepts(material, parameterName, parameter);
    if (!validated && (material instanceof PostProcessMaterialObject || this.validateLegacyMeshParameters)) return false;
    if (material instanceof PostProcessMaterialObject) {
      if (!material.entry.id) return false;
      const owner = material.owner;
      const target: Extract<CommandMessage, { type: "setPostProcessMaterialParameter" }>["owner"] = owner instanceof SceneLayer
        ? { kind: "sceneLayer", layerId: owner.guid, layerLoadId: this.host.layers().get(owner.guid)!.loadId }
        : { kind: "scene", sceneAssetGuid: owner.assetGuid, sceneLoadId: this.host.sceneRealizer().loadId };
      this.host.emit({ type: "setPostProcessMaterialParameter", owner: target, entryId: material.entry.id,
        materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
    } else {
      const component = material.component;
      const owner = component.owner;
      if (!owner || owner.destroyed || component.destroyed || component.getVariable("materialObject") !== material) return false;
      const slotId = this.host.renderSlots().recordedSlot(owner);
      if (slotId === undefined) return false;
      if (!this.host.renderEmitter().rendersComponent(owner, component)) return false;
      this.host.emit({ type: "setMaterialParameter", slotId, componentId: component.guid,
        materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
    }
    if (validated) this.host.materialParameters().set(material, parameterName, parameter);
    return true;
  }
}
