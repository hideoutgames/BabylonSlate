import { runtimeEditWorldTransform } from "./runtime-transform-edit";
import type { SerializedTransform } from "@babylonslate/core";
import type {
  RuntimeIdentityCursor, RuntimeIdentityRow, RuntimeInspectorAction, RuntimeInspectorPayload,
  RuntimeInspectorRequest, RuntimeInspectorResult, RuntimeInspectorValue, RuntimeObjectIdentity,
  RuntimePropertyCapability, RuntimePropertyDescriptor,
} from "@babylonslate/bridge";
import { Actor, ActorComponent, BObject, MaterialObject, engineScriptApiFor, type World } from "@babylonslate/object-model";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";

const MAX_BATCH_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 48 * 1024;
const PAGE_ROWS = 128;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype", "parentId", "ownerId", "guid", "classId", "locked", "sourceId", "world"]);
const SCALAR_TYPES = new Set(["bool", "boolean", "float", "int", "number", "string", "vec2", "vec3", "vec4", "color", "quat", "actor", "object", "component", "class", "asset"]);
const LIVE_COMPONENTS = new Set(["MeshComponent", "DynamicRuntimeMeshComponent", "CameraComponent", "LightComponent", "HemisphericFillLightComponent", "OutlineComponent", "RigidBodyComponent", "ColliderComponent", "NavAgentComponent"]);
const LIVE_MESH_PROPERTIES = new Set(["castShadows", "receiveShadows", "materialGuid"]);

type Target = Actor | ActorComponent;
type Descriptor = Omit<RuntimePropertyDescriptor, "value"> & { keyTypeId?: string };
type Boundary = Pick<RuntimeInspectorResult, "tickIndex" | "frameId" | "commandRevision" | "structuralRevision">;
export interface RuntimeInspectorHost {
  world: World;
  materials: RuntimeMaterialParameters;
  sessionGeneration: number;
  canWrite(): boolean;
  stopped(): boolean;
  sceneIdentity(actor: Actor): string;
  ready(actor: Actor): boolean;
  renderSlot(actor: Actor): number | undefined;
  resolvePick(actorGuid: string, slotId: number): Actor | null;
  boundary(): Boundary;
  applyProperty(target: Target, key: string, value: unknown): void;
  applyTransform(target: Target, transform: SerializedTransform, space?: "local" | "world"): void;
  applyMaterial(component: ActorComponent, name: string, value: import("@babylonslate/core").MaterialParameterValue): boolean;
}

/** No subscriptions or hot-path collection. The driver invokes requests at a completed tick boundary. */
export class RuntimeInspector {
  private readonly tokens = new WeakMap<BObject, number>();
  private nextToken = 0;
  /** Weak ownership: editing a destroyed object never retains it through a session. */
  private readonly sequences = new WeakMap<Target, Map<string, number>>();
  private readonly host: RuntimeInspectorHost;
  constructor(host: RuntimeInspectorHost) { this.host = host; }

  result(request: RuntimeInspectorRequest, reason?: string): RuntimeInspectorResult {
    return { sessionGeneration: request.sessionGeneration, requestId: request.requestId, success: !reason,
      ...(reason ? { reason } : {}), ...this.host.boundary() };
  }

  /** Reject oversized requests before cloning or building JSON. */
  validateRequest(request: RuntimeInspectorRequest): string | null {
    if (!request || request.sessionGeneration !== this.host.sessionGeneration) return "Stale session generation.";
    if (!Number.isSafeInteger(request.requestId) || request.requestId < 1) return "Invalid request ID.";
    if (this.host.stopped()) return "The game session has stopped.";
    try { boundedInput(request); } catch (error) { return message(error); }
    const action = request.action;
    if (!action || !["resolvePick", "identities", "selection", "value", "setProperty", "setTransform", "setMaterialParameter"].includes(action.kind)) return "Unsupported Inspector operation.";
    if (isMutation(action) && !this.host.canWrite()) return "Live editing is available only during Simulation Play.";
    return null;
  }

  execute(request: RuntimeInspectorRequest): RuntimeInspectorResult {
    const invalid = this.validateRequest(request);
    if (invalid) return this.result(request, invalid);
    try {
      const action = request.action;
      const budget = { remaining: MAX_VALUE_BYTES, nodes: 1024, truncated: false };
      let payload: RuntimeInspectorPayload;
      if (action.kind === "identities") payload = this.identities(action);
      else if (action.kind === "resolvePick") {
        if (typeof action.actorGuid !== "string" || !Number.isSafeInteger(action.slotId) || action.slotId < 0) throw new Error("Invalid rendered selection.");
        const actor = this.host.resolvePick(action.actorGuid, action.slotId);
        if (!actor) throw new Error("The rendered actor was destroyed or replaced.");
        payload = { kind: "identity", row: { kind: "actor", identity: this.identity(actor), classId: actor.classId,
          name: String(actor.getVariable("name") ?? actor.classId).slice(0, 512), parent: null, renderSlotId: action.slotId } };
      }
      else {
        const target = this.resolveTarget(action.target);
        if (!target) throw new Error("The selected object was destroyed, replaced, or belongs to another scene instance.");
        if (action.kind === "selection") payload = this.selection(target, action.target, action.offset, budget);
        else if (action.kind === "value") payload = this.valuePage(target, action.property, action.offset, budget);
        else payload = this.mutate(target, action, budget);
      }
      const result = { ...this.result(request), payload, ...(budget.truncated ? { truncated: true } : {}) };
      // Values are bounded during traversal. This final envelope check accounts for metadata too.
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BATCH_BYTES) return this.result(request, "Inspector response exceeds the 64 KiB transport budget; request a smaller page.");
      return result;
    } catch (error) { return this.result(request, message(error)); }
  }

  identity(target: Target): RuntimeObjectIdentity {
    const actor = target instanceof Actor ? target : target.owner!;
    return { sceneInstanceId: this.host.sceneIdentity(actor), actorGuid: actor.guid, actorToken: this.token(actor),
      ...(target instanceof ActorComponent ? { componentGuid: target.guid, componentToken: this.token(target) } : {}) };
  }
  private token(target: BObject): number {
    const prior = this.tokens.get(target);
    if (prior !== undefined) return prior;
    const token = ++this.nextToken; this.tokens.set(target, token); return token;
  }
  resolveTarget(identity: RuntimeObjectIdentity): Target | null {
    if (!identity || typeof identity.actorGuid !== "string" || !Number.isSafeInteger(identity.actorToken) || typeof identity.sceneInstanceId !== "string") return null;
    const actor = this.host.world.findActorInstances(identity.actorGuid).find(candidate => !candidate.destroyed &&
      candidate.world === this.host.world && this.tokens.get(candidate) === identity.actorToken && this.host.sceneIdentity(candidate) === identity.sceneInstanceId);
    if (!actor) return null;
    if (identity.componentGuid === undefined) return identity.componentToken === undefined ? actor : null;
    return actor.components.find(component => !component.destroyed && component.owner === actor && component.guid === identity.componentGuid &&
      this.tokens.get(component) === identity.componentToken) ?? null;
  }
  private identities(action: Extract<RuntimeInspectorAction, { kind: "identities" }>): RuntimeInspectorPayload {
    const revision = this.host.boundary().structuralRevision;
    if (action.knownRevision === revision && !action.cursor) return { kind: "identities", rows: [], unchanged: true };
    const cursor: RuntimeIdentityCursor = action.cursor ?? { revision, actorIndex: 0, componentIndex: -1 };
    if (cursor.revision !== revision) throw new Error("The runtime structure changed; restart identity paging.");
    if (!Number.isSafeInteger(cursor.actorIndex) || cursor.actorIndex < 0 || !Number.isSafeInteger(cursor.componentIndex) || cursor.componentIndex < -1) throw new Error("Invalid identity page cursor.");
    const actors = this.host.world.getActors(); const rows: RuntimeIdentityRow[] = [];
    let actorIndex = cursor.actorIndex; let componentIndex = cursor.componentIndex; let bytes = 0;
    while (actorIndex < actors.length && rows.length < PAGE_ROWS && bytes < MAX_VALUE_BYTES - 2048) {
      const actor = actors[actorIndex]!;
      if (actor.destroyed) { actorIndex++; componentIndex = -1; continue; }
      if (componentIndex === -1) {
        const parentGuid = actor.getVariable("parentId");
        const parent = typeof parentGuid === "string" ? this.host.world.findActorInstances(parentGuid).find(candidate =>
          !candidate.destroyed && this.host.sceneIdentity(candidate) === this.host.sceneIdentity(actor)) : undefined;
        const row: RuntimeIdentityRow = { kind: "actor", identity: this.identity(actor), renderSlotId: this.host.renderSlot(actor), classId: actor.classId.slice(0, 512),
          name: String(actor.getVariable("name") ?? actor.classId).slice(0, 512), parent: parent ? this.identity(parent) : null };
        rows.push(row); bytes += JSON.stringify(row).length * 3; componentIndex = 0;
      } else if (componentIndex < actor.components.length) {
        const component = actor.components[componentIndex++]!;
        if (component.destroyed || component.owner !== actor) continue;
        const parent = component.parentId ? actor.components.find(candidate => candidate.guid === component.parentId && !candidate.destroyed) : undefined;
        const row: RuntimeIdentityRow = { kind: "component", identity: this.identity(component), renderSlotId: this.host.renderSlot(actor), classId: component.classId.slice(0, 512),
          name: component.classId.slice(0, 512), parent: this.identity(parent ?? actor) };
        rows.push(row); bytes += JSON.stringify(row).length * 3;
      } else { actorIndex++; componentIndex = -1; }
    }
    return { kind: "identities", rows, unchanged: false, ...(actorIndex < actors.length ? { nextCursor: { revision, actorIndex, componentIndex } } : {}) };
  }
  private descriptors(target: Target): Descriptor[] {
    const values = new Map<string, Descriptor>();
    if (target instanceof Actor) {
      for (const [key, name, typeId] of [["name", "Name", "string"], ["visible", "Visible", "bool"], ["generateHitEvents", "Generate Hit Events", "bool"], ["generateOverlapEvents", "Generate Overlap Events", "bool"]])
        values.set(key!, { key: key!, name: name!, typeId: typeId!, capability: "live" });
    }
    for (const classId of this.host.world.classRegistry.ancestry(target.classId).reverse()) {
      for (const variable of engineScriptApiFor(classId)?.variables ?? []) {
        const { propertyKey: key, name, typeId, typeClassId, container } = variable;
        let capability: RuntimePropertyCapability = variable.getOnly || FORBIDDEN.has(key) ? "readOnly" : "restart";
        if (capability !== "readOnly" && target instanceof ActorComponent && SCALAR_TYPES.has(typeId) && container !== "map") {
          if (LIVE_COMPONENTS.has(classId) && (!["MeshComponent", "DynamicRuntimeMeshComponent"].includes(classId) || LIVE_MESH_PROPERTIES.has(key))) capability = "live";
          if (classId === "AudioComponent" && key === "volume") capability = "live";
          if (classId === "ColliderComponent") capability = "rebuild";
        }
        if (typeId === "asset" && key !== "materialGuid") capability = "restart";
        values.set(key, { key, name, typeId, ...(typeClassId ? { typeClassId } : {}), ...(container ? { container } : {}), capability,
          ...(capability === "restart" ? { reason: "This runtime owner requires a new session for this field." } : capability === "readOnly" ? { reason: "Computed, structural, or unsupported runtime state." } : {}) });
      }
    }
    for (const variable of this.host.world.classRegistry.inheritedVariables(target.classId)) {
      if (FORBIDDEN.has(variable.name) || values.has(variable.name)) continue;
      const capability = SCALAR_TYPES.has(variable.type) && !["class", "asset"].includes(variable.type) ? "live" : "readOnly";
      values.set(variable.name, { key: variable.name, name: variable.name, typeId: variable.type,
        ...(variable.typeClassId ? { typeClassId: variable.typeClassId } : {}), ...(variable.container ? { container: variable.container } : {}),
        ...(variable.keyTypeId ? { keyTypeId: variable.keyTypeId } : {}), capability,
        ...(capability === "readOnly" ? { reason: "No validated live authoring codec is available for this type." } : {}) });
    }
    if (target instanceof ActorComponent) {
      const material = target.getVariable("materialObject");
      if (material instanceof MaterialObject) for (const [name, value] of Object.entries(this.host.materials.describe(material) ?? {})) {
        values.set(`material:${name}`, { key: `material:${name}`, name, typeId: `material:${value.kind}`, capability: "live" });
      }
    }
    return [...values.values()];
  }
  private read(target: Target, descriptor: Descriptor): unknown {
    if (target instanceof Actor && descriptor.key === "generateHitEvents") return target.generateHitEvents;
    if (target instanceof Actor && descriptor.key === "generateOverlapEvents") return target.generateOverlapEvents;
    if (target instanceof ActorComponent && descriptor.key.startsWith("material:")) {
      const material = target.getVariable("materialObject");
      return material instanceof MaterialObject ? this.host.materials.describe(material)?.[descriptor.key.slice(9)] : undefined;
    }
    return target.getVariable(descriptor.key);
  }
  private selection(target: Target, identity: RuntimeObjectIdentity, requestedOffset: number | undefined, budget: Budget): RuntimeInspectorPayload {
    const offset = pageOffset(requestedOffset); const descriptors = this.descriptors(target); const properties: RuntimePropertyDescriptor[] = [];
    let index = offset;
    while (index < descriptors.length && properties.length < 64 && budget.remaining > 2048) {
      const descriptor = descriptors[index++]!;
      properties.push({ ...descriptor, value: this.encode(this.read(target, descriptor), budget, 0, false) });
      budget.remaining -= JSON.stringify(descriptor).length * 3;
    }
    const transformReason = this.transformRestriction(target);
    return { kind: "selection", target: identity, classId: target.classId, transform: serializedTransform(target),
      worldTransform: runtimeEditWorldTransform(this.host.world, target), renderSlotId: this.host.renderSlot(target instanceof Actor ? target : target.owner!),
      ...(target instanceof ActorComponent ? { materialGuid: typeof target.getVariable("materialGuid") === "string" ? target.getVariable("materialGuid") as string : null } : {}),
      transformCapability: transformReason ? "restart" : "live", ...(transformReason ? { transformReason } : {}), properties,
      ...(index < descriptors.length ? { nextOffset: index } : {}) };
  }
  private valuePage(target: Target, property: string, requestedOffset: number | undefined, budget: Budget): RuntimeInspectorPayload {
    const descriptor = this.descriptors(target).find(entry => entry.key === property);
    if (!descriptor) throw new Error("This property is not exposed by the runtime schema.");
    const value = this.read(target, descriptor); const offset = pageOffset(requestedOffset);
    const collection = Array.isArray(value) ? value : value instanceof Map ? value : null;
    if (!collection) return { kind: "value", property, value: this.encode(value, budget, 0, true) };
    const length = Array.isArray(collection) ? collection.length : collection.size;
    const items: RuntimeInspectorValue[] = []; let index = offset;
    const iterator = collection instanceof Map ? collection.entries() : null;
    if (iterator) for (let skip = 0; skip < offset && skip < length; skip++) iterator.next();
    while (index < length && items.length < 64 && budget.remaining > 2048) {
      const item = iterator ? iterator.next().value : (collection as unknown[])[index];
      items.push(this.encode(item, budget, 0, true)); index++;
    }
    if (index < length) budget.truncated = true;
    return { kind: "value", property, value: { $runtime: collection instanceof Map ? "map" : "array", length, offset, items },
      ...(index < length ? { nextOffset: index } : {}) };
  }
  private mutate(target: Target, action: Extract<RuntimeInspectorAction, { sequence: number }>, budget: Budget): RuntimeInspectorPayload {
    const actor = target instanceof Actor ? target : target.owner!;
    if (!this.host.ready(actor)) throw new Error("This scene instance is loading or no longer accepts edits.");
    if (!Number.isSafeInteger(action.sequence) || action.sequence < 1) throw new Error("Invalid target sequence.");
    const key = action.kind === "setProperty" ? `property:${action.property}` : action.kind === "setMaterialParameter" ? `material:${action.parameter}` : "transform";
    let sequences = this.sequences.get(target);
    if (action.sequence <= (sequences?.get(key) ?? 0)) throw new Error("This write was superseded by a newer target sequence.");
    if (sequences && !sequences.has(key) && sequences.size >= 256) throw new Error("This object has reached its live edit target budget.");
    // Sequences are bounded by reflected fields; rejected arbitrary keys never allocate entries.
    let effective: unknown;
    if (action.kind === "setProperty") {
      const descriptor = this.descriptors(target).find(entry => entry.key === action.property);
      if (!descriptor || !["live", "rebuild"].includes(descriptor.capability) || descriptor.key.startsWith("material:")) throw new Error("This property is read-only or requires a new session.");
      const value = this.decode(action.value, descriptor);
      validateProperty(target, descriptor.key, value);
      if (descriptor.typeId === "asset" && (value !== null && (typeof value !== "string" || !this.host.materials.acceptsAssignment(value)))) throw new Error("The material is unavailable or is not a surface material.");
      this.host.applyProperty(target, descriptor.key, value);
      effective = this.read(target, descriptor);
    } else if (action.kind === "setTransform") {
      const restriction = this.transformRestriction(target);
      if (restriction) throw new Error(restriction);
      validateTransform(action.transform);
      if (action.space !== undefined && action.space !== "local" && action.space !== "world") throw new Error("Unknown transform coordinate space.");
      this.host.applyTransform(target, action.transform, action.space);
      effective = serializedTransform(target);
    } else {
      if (!(target instanceof ActorComponent)) throw new Error("Select an existing mesh component to edit its material instance.");
      const material = target.getVariable("materialObject");
      if (!(material instanceof MaterialObject) || material.materialAssetGuid !== action.materialGuid ||
        !this.host.materials.accepts(material, action.parameter, action.value)) throw new Error("The material instance, parameter, or typed value is unavailable.");
      if (!this.host.applyMaterial(target, action.parameter, action.value)) throw new Error("The material owner rejected the edit.");
      effective = this.host.materials.get(material, action.parameter, action.value.kind);
    }
    if (!sequences) { sequences = new Map(); this.sequences.set(target, sequences); }
    sequences.set(key, action.sequence);
    return { kind: "mutation", target: action.target, sequence: action.sequence, effectiveValue: this.encode(effective, budget, 0, true) };
  }
  private transformRestriction(target: Target): string | null {
    const actor = target instanceof Actor ? target : target.owner!;
    if (actor.components.some(component => !component.destroyed && component.classId === "RagdollComponent"))
      return "Ragdoll transforms require a new session; live teleport cannot preserve articulated body state.";
    if (target instanceof ActorComponent && ["PhysicsConstraintComponent", "SceneStreamingComponent"].includes(target.classId))
      return "This component owner does not support live local transform replacement.";
    return null;
  }
  private decode(value: RuntimeInspectorValue, descriptor: Descriptor): unknown {
    if (descriptor.container === "array") {
      if (!Array.isArray(value) || value.length > 256) throw new Error("An array edit must contain at most 256 typed values.");
      return value.map(item => this.decode(item, { ...descriptor, container: "single" }));
    }
    if (descriptor.container === "map") {
      if (!isRecord(value) || value.$runtime !== "map" || !Array.isArray(value.entries) || value.entries.length > 256) throw new Error("A map edit must contain at most 256 typed entries.");
      const result = new Map<unknown, unknown>();
      for (const entry of value.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid map entry.");
        const key = this.decode(entry[0]!, { ...descriptor, container: "single", typeId: descriptor.keyTypeId ?? "string" });
        if (result.has(key)) throw new Error("Duplicate map key.");
        result.set(key, this.decode(entry[1]!, { ...descriptor, container: "single" }));
      }
      return result;
    }
    const type = descriptor.typeId;
    if (["actor", "object", "component"].includes(type)) {
      if (value === null) return null;
      if (!isRecord(value) || value.$runtime !== "reference" || !isRecord(value.target)) throw new Error("A typed runtime object reference is required.");
      const target = this.resolveTarget(value.target as unknown as RuntimeObjectIdentity);
      if (!target || (type === "actor" && !(target instanceof Actor)) || (type === "component" && !(target instanceof ActorComponent)) ||
        (descriptor.typeClassId && !this.host.world.classRegistry.isA(target.classId, descriptor.typeClassId))) throw new Error("The referenced object is missing or has the wrong class.");
      return target;
    }
    if (["float", "number", "int"].includes(type)) {
      if (typeof value !== "number" || !Number.isFinite(value) || (type === "int" && !Number.isSafeInteger(value))) throw new Error("A finite number of the declared type is required.");
      return value;
    }
    if (type === "bool" || type === "boolean") { if (typeof value !== "boolean") throw new Error("A boolean is required."); return value; }
    if (["string", "class", "asset"].includes(type)) {
      if (type === "asset" && value === null) return null;
      if (typeof value !== "string" || value.length > 8192) throw new Error("A bounded string is required."); return value;
    }
    const keys = type === "vec2" ? ["x", "y"] : type === "vec3" ? ["x", "y", "z"] : ["vec4", "quat"].includes(type) ? ["x", "y", "z", "w"] : type === "color" ? ["r", "g", "b", "a"] : null;
    if (keys) {
      if (Array.isArray(value) && value.length === keys.length && value.every(item => typeof item === "number" && Number.isFinite(item))) return [...value];
      if (isRecord(value) && keys.every(key => typeof value[key] === "number" && Number.isFinite(value[key]))) return Object.fromEntries(keys.map(key => [key, value[key]]));
      throw new Error(`A finite ${type} value is required.`);
    }
    throw new Error("No validated live authoring codec is available for this type.");
  }
  private encode(value: unknown, budget: Budget, depth: number, expand: boolean): RuntimeInspectorValue {
    if (--budget.nodes < 0 || budget.remaining < 256 || depth > 6) { budget.truncated = true; return { $runtime: "unavailable", reason: "Value budget reached" }; }
    budget.remaining -= 64;
    if (value === undefined) return { $runtime: "undefined" };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : { $runtime: "unavailable", reason: "Non-finite number" };
    if (typeof value === "string") {
      if (value.length > 8192 || value.length * 3 > budget.remaining) { budget.truncated = true; return { $runtime: "unavailable", reason: "String exceeds value budget", length: value.length }; }
      budget.remaining -= value.length * 3; return value;
    }
    if (value instanceof Actor || value instanceof ActorComponent) {
      if (value.destroyed || value instanceof ActorComponent && (!value.owner || value.owner.destroyed)) return { $runtime: "unavailable", reason: "Destroyed reference" };
      return { $runtime: "reference", target: this.identity(value), classId: value.classId };
    }
    if (Array.isArray(value) || value instanceof Map) {
      const length = Array.isArray(value) ? value.length : value.size;
      if (!expand || length > 64) { budget.truncated ||= length > 0; return { $runtime: value instanceof Map ? "map" : "array", length }; }
      if (value instanceof Map) return { $runtime: "map", entries: [...value].map(([key, item]) => [this.encode(key, budget, depth + 1, true), this.encode(item, budget, depth + 1, true)]) };
      return value.map(item => this.encode(item, budget, depth + 1, true));
    }
    if (isRecord(value)) {
      const keys = Object.keys(value);
      if (keys.length > 64) { budget.truncated = true; return { $runtime: "unavailable", reason: "Structure exceeds field budget" }; }
      const result: Record<string, RuntimeInspectorValue> = {};
      for (const key of keys) if (!FORBIDDEN.has(key)) result[key] = this.encode(value[key], budget, depth + 1, expand);
      return result;
    }
    return { $runtime: "unavailable", reason: "Unsupported runtime value" };
  }
}

type Budget = { remaining: number; nodes: number; truncated: boolean };
function message(error: unknown): string { return error instanceof Error ? error.message : "Runtime Inspector request failed."; }
function isRecord(value: unknown): value is Record<string, RuntimeInspectorValue> { return !!value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function isMutation(action: RuntimeInspectorAction): boolean { return action.kind === "setProperty" || action.kind === "setTransform" || action.kind === "setMaterialParameter"; }
function pageOffset(value: number | undefined): number { if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid value page offset."); return value ?? 0; }
function boundedInput(value: unknown): void {
  let remaining = MAX_BATCH_BYTES; let nodes = 4096;
  const visit = (item: unknown, depth: number) => {
    if (--nodes < 0 || depth > 12 || remaining < 0) throw new Error("Inspector request exceeds its bounded transport budget.");
    remaining -= 32;
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite numbers are not supported.");
    if (typeof item === "string") remaining -= item.length * 3;
    else if (Array.isArray(item)) { if (item.length > 1024) throw new Error("Inspector request array is too large."); for (const child of item) visit(child, depth + 1); }
    else if (isRecord(item)) { const keys = Object.keys(item); if (keys.length > 256) throw new Error("Inspector request has too many fields."); for (const key of keys) { remaining -= key.length * 3; visit(item[key], depth + 1); } }
    else if (item !== null && !["number", "boolean", "undefined"].includes(typeof item)) throw new Error("Unsupported Inspector transport value.");
    if (remaining < 0) throw new Error("Inspector request exceeds its bounded transport budget.");
  };
  visit(value, 0);
}
function serializedTransform(target: Target): SerializedTransform {
  const { position: p, rotation: r, scale: s } = target.transform;
  return { position: [p.x, p.y, p.z], rotation: [r.x, r.y, r.z, r.w], scale: [s.x, s.y, s.z] };
}
function validateTransform(transform: SerializedTransform): void {
  if (!transform || !Array.isArray(transform.position) || transform.position.length !== 3 || !Array.isArray(transform.rotation) || transform.rotation.length !== 4 ||
    !Array.isArray(transform.scale) || transform.scale.length !== 3 || ![...transform.position, ...transform.rotation, ...transform.scale].every(Number.isFinite) ||
    transform.scale.some(value => Math.abs(value) < 1e-6) || Math.abs(Math.hypot(...transform.rotation) - 1) > 0.001) throw new Error("A finite local transform with nonzero scale and a unit quaternion is required.");
}
function validateProperty(target: Target, key: string, value: unknown): void {
  if (FORBIDDEN.has(key)) throw new Error("Structural authoring is read-only during Simulation Play.");
  if (target instanceof ActorComponent) {
    if (key === "motionType" && !["static", "dynamic", "kinematic"].includes(String(value))) throw new Error("Unknown physics motion type.");
    if (key === "projectionMode" && !["perspective", "orthographic"].includes(String(value))) throw new Error("Unknown camera projection mode.");
    if (key === "lightKind" && !["directional", "point", "spot"].includes(String(value))) throw new Error("Unknown light kind.");
    if (["mass", "friction", "restitution", "linearDamping", "angularDamping", "volume", "intensity", "range", "width"].includes(key) && typeof value === "number" && value < 0) throw new Error("This property must be nonnegative.");
    if (["nearClip", "farClip", "orthographicSize", "fieldOfView"].includes(key) && (typeof value !== "number" || value <= 0)) throw new Error("This camera property must be positive.");
  }
}
