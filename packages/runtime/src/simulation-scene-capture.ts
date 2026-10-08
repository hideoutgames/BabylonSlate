import { normalizeScene } from "@babylonslate/core";
import type { MaterialParameterValue, SceneSettings, SerializedActor, SerializedComponent, SerializedScene, SerializedTransform, Transform } from "@babylonslate/core";
import { Actor, ActorComponent, BObject, engineScriptApiFor, sceneActorProvenance, sceneComponentProvenance, type VariableDef, type World } from "@babylonslate/object-model";
import { defaultComponentAuthoringProperties } from "./component-authoring";

export interface SimulationCaptureIdentity {
  generation: number;
  sceneAssetGuid: string;
  sceneInstanceId: string;
  sceneLoadId: number;
  tickIndex: number;
  commandRevision: number;
}

export interface SimulationSceneCaptureInput {
  world: World;
  baseline: SerializedScene;
  identity: SimulationCaptureIdentity;
  startingScene: Pick<SimulationCaptureIdentity, "sceneAssetGuid" | "sceneInstanceId" | "sceneLoadId">;
  /** Must be acknowledged by the runtime boundary owner. */
  quiescent: boolean;
  /** Owner-confirmed render commands and authorable scene settings, not a UI poll. */
  renderRevision: number;
  sceneSettings: SceneSettings;
  ownership(actor: Actor): "root" | "stream" | "layer" | "unknown";
  /** Includes independent instances even when they currently contain no actors. */
  independentInstances?: readonly { kind: "stream" | "layer"; id: string }[];
  materialOverrides(component: ActorComponent): Record<string, MaterialParameterValue> | null;
  prefabComponents(classId: string): readonly SerializedComponent[];
  /** Validate referenced authored resources against the prepared asset scope. */
  assetExists(guid: string): boolean;
  /** Prepared authoring metadata; no getter execution or heap inference. */
  structFields?(typeClassId: string): readonly VariableDef[] | null;
  enumMembers?(typeClassId: string): readonly string[] | null;
  maxBytes?: number;
  maxNodes?: number;
}

export type SimulationSceneCaptureResult =
  | { ok: true; scene: SerializedScene; identity: SimulationCaptureIdentity; byteSize: number }
  | { ok: false; code: "boundary" | "ownership" | "value" | "reference" | "resource" | "budget"; reason: string; path: string; identity: SimulationCaptureIdentity };

class CaptureFailure extends Error {
  readonly code: Exclude<SimulationSceneCaptureResult, { ok: true }>["code"];
  readonly path: string;
  constructor(code: CaptureFailure["code"], path: string, message: string) { super(message); this.code = code; this.path = path; }
}

function fail(code: CaptureFailure["code"], path: string, reason: string): never { throw new CaptureFailure(code, path, reason); }

/** UTF-8 JSON string cost without creating another large string or byte buffer. */
function stringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const char = value.charCodeAt(index);
    if (char === 34 || char === 92 || [8, 9, 10, 12, 13].includes(char)) bytes += 2;
    else if (char < 32) bytes += 6;
    else if (char < 128) bytes++;
    else if (char < 2048) bytes += 2;
    else if (char >= 0xd800 && char <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += char >= 0xd800 && char <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

class Budget {
  bytes = 0;
  nodes = 0;
  readonly maxBytes: number;
  readonly maxNodes: number;
  constructor(maxBytes: number, maxNodes: number) {
    this.maxBytes = maxBytes; this.maxNodes = maxNodes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxNodes) || maxNodes < 1) fail("budget", "scene", "Invalid scene capture budget.");
  }
  add(bytes: number, path: string): void {
    this.bytes += bytes;
    if (++this.nodes > this.maxNodes || this.bytes > this.maxBytes) fail("budget", path, "Complete scene capture exceeds its retained-data budget.");
  }
}

type Reference = { actorId: string; componentId?: string };
type Field = Pick<VariableDef, "type" | "container" | "defaultValue" | "keyTypeId" | "typeClassId" | "keyTypeClassId">;

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

/** One quiescent, bounded traversal of authorable state; never mutates the world or baseline. */
export function captureSimulationScene(input: SimulationSceneCaptureInput): SimulationSceneCaptureResult {
  const identity = { ...input.identity };
  try {
    if (!input.quiescent || input.renderRevision !== identity.commandRevision) fail("boundary", "scene", "The runtime and renderer have not acknowledged the same final boundary.");
    for (const key of ["sceneAssetGuid", "sceneInstanceId", "sceneLoadId"] as const) {
      if (identity[key] !== input.startingScene[key]) fail("ownership", "scene", "Keep cannot retain a scene transition into the starting document.");
    }
    const instance = input.independentInstances?.[0];
    if (instance) fail("ownership", instance.id, `Keep cannot retain an independent ${instance.kind === "layer" ? "SceneLayer" : "streamed Scene"} instance.`);
    const budget = new Budget(input.maxBytes ?? 16 * 1024 * 1024, input.maxNodes ?? 250_000);
    const references = new Map<BObject, Reference>();
    const live: Actor[] = [];
    const byGuid = new Map<string, Actor>();
    const beforeById = new Map<string, SerializedActor>();
    const reserved = new Set<string>();
    for (const actor of input.baseline.actors) {
      if (reserved.has(actor.id)) fail("reference", actor.id, "The authoring baseline has duplicate actor IDs.");
      reserved.add(actor.id); beforeById.set(actor.id, actor);
    }
    let sequence = 0;
    const nextId = (prefix: string, taken: Set<string>): string => {
      let id: string;
      do { id = `${prefix}-${++sequence}`; } while (taken.has(id));
      taken.add(id); return id;
    };
    const usedActorIds = new Set<string>();
    for (const actor of input.world.getActors()) {
      if (actor.destroyed) continue;
      budget.add(1, actor.guid);
      if (actor.sceneLayerId || input.ownership(actor) !== "root") fail("ownership", actor.guid, "Keep requires every surviving actor to belong to the starting root scene.");
      if (!input.world.classRegistry.has(actor.classId)) fail("resource", actor.guid, `Class ${actor.classId} has no authored schema.`);
      byGuid.set(actor.guid, actor);
      const source = sceneActorProvenance(actor);
      if (source && !beforeById.has(source)) fail("ownership", source, "An authored actor belongs to a different scene realization.");
      const id = source ?? nextId("simulation-actor", reserved);
      if (usedActorIds.has(id)) fail("reference", id, "Multiple runtime actors claim the same authored identity.");
      usedActorIds.add(id); references.set(actor, { actorId: id }); live.push(actor);
      const componentIds = new Set(beforeById.get(id)?.components.map((component) => component.id) ?? []);
      const used = new Set<string>();
      for (const component of actor.components) {
        if (component.destroyed) continue;
        budget.add(1, `${id}.${component.guid}`);
        if (!input.world.classRegistry.has(component.classId)) fail("resource", component.guid, `Class ${component.classId} has no authored schema.`);
        if (component.owner !== actor) fail("ownership", component.guid, "Component owner changed outside the scene boundary.");
        const sourceId = sceneComponentProvenance(component);
        const componentId = source && sourceId ? sourceId : nextId(`${id}-component`, componentIds);
        if (used.has(componentId)) fail("reference", componentId, "Multiple runtime components claim the same authored identity.");
        used.add(componentId); references.set(component, { actorId: id, componentId });
      }
    }

    const ancestors = new Set<object>();
    const encode = (value: unknown, path: string, depth = 0): unknown => {
      if (depth > 64) fail("budget", path, "Scene value nesting exceeds the capture limit.");
      if (value === null) { budget.add(4, path); return null; }
      if (value === undefined) { budget.add(27, path); return { $sceneValue: "undefined" }; }
      if (typeof value === "boolean") { budget.add(value ? 4 : 5, path); return value; }
      if (typeof value === "string") { budget.add(stringBytes(value), path); return value; }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) fail("value", path, "An authorable number is not finite.");
        budget.add(String(value).length, path); return Object.is(value, -0) ? 0 : value;
      }
      if (value instanceof Actor || value instanceof ActorComponent) {
        const reference = references.get(value);
        if (!reference || value.destroyed) fail("reference", path, "An authorable value references a destroyed or independently owned object.");
        budget.add(stringBytes(reference.actorId) + (reference.componentId ? stringBytes(reference.componentId) : 0) + 64, path);
        return { $sceneValue: "reference", ...reference };
      }
      if (value instanceof BObject || typeof value !== "object") fail("resource", path, "The value has no editable scene representation.");
      if (ancestors.has(value)) fail("value", path, "Cyclic authorable data cannot be retained.");
      ancestors.add(value);
      try {
        if (value instanceof Map) {
          budget.add(36, path);
          const entries: unknown[][] = [];
          for (const [key, entry] of value) entries.push([encode(key, `${path}.key`, depth + 1), encode(entry, `${path}.value`, depth + 1)]);
          return { $sceneValue: "map", entries };
        }
        if (Array.isArray(value)) {
          budget.add(value.length + 2, path);
          const result: unknown[] = [];
          for (let index = 0; index < value.length; index++) {
            if (!Object.hasOwn(value, index)) fail("value", path, "Sparse authorable arrays cannot be retained.");
            result.push(encode(value[index], `${path}[${index}]`, depth + 1));
          }
          return result;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("resource", path, "A native or custom object has no editable scene codec.");
        if (Object.hasOwn(value, "$sceneValue") || Object.getOwnPropertySymbols(value).length) fail("value", path, "Authorable data uses a reserved scene value key or symbol.");
        budget.add(2, path);
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in descriptor)) fail("value", `${path}.${key}`, "An authorable getter cannot be evaluated during capture.");
          budget.add(stringBytes(key) + 2, path);
          Object.defineProperty(result, key, { value: encode(descriptor.value, `${path}.${key}`, depth + 1), enumerable: true, configurable: true, writable: true });
        }
        return result;
      } finally { ancestors.delete(value); }
    };

    const typed = (value: unknown, field: Field, path: string, depth = 0): unknown => {
      if (depth > 64) fail("budget", path, "Reflected value nesting exceeds the capture limit.");
      if (field.container === "map") {
        if (!(value instanceof Map)) fail("value", path, "A reflected Map variable is not a Map.");
        budget.add(2, path);
        const entries: Array<{ key: unknown; value: unknown }> = [];
        for (const [key, item] of value) {
          budget.add(20, path);
          entries.push({ key: typed(key, { type: field.keyTypeId ?? "string", typeClassId: field.keyTypeClassId }, `${path}.key`, depth + 1), value: typed(item, { ...field, container: "single" }, `${path}.value`, depth + 1) });
        }
        return depth === 0 ? entries : { $sceneValue: "map", entries: entries.map(entry => [entry.key, entry.value]) };
      }
      if (field.container === "array") {
        if (!Array.isArray(value)) fail("value", path, "A reflected Array variable is not an Array.");
        budget.add(value.length + 2, path);
        return Array.from({ length: value.length }, (_, index) => {
          if (!Object.hasOwn(value, index)) fail("value", path, "Sparse authorable arrays cannot be retained.");
          return typed(value[index], { ...field, container: "single" }, `${path}[${index}]`, depth + 1);
        });
      }
      if (value !== null && value !== undefined) {
        if (field.type === "struct" || field.type === "tagContainer" || field.type === "struct:engine:TagContainer") {
          if (typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail("value", path, "A reflected Structure must contain plain authorable fields.");
          const schema = field.type === "tagContainer" || field.type === "struct:engine:TagContainer" || field.typeClassId === "engine:TagContainer"
            ? [{ name: "Tags", type: "tag", container: "array" as const }] : field.typeClassId ? input.structFields?.(field.typeClassId) : null;
          if (!schema) fail("resource", path, `Structure ${field.typeClassId ?? "(unspecified)"} has no prepared authoring schema.`);
          const result: Record<string, unknown> = {};
          budget.add(2, path);
          for (const name of Object.keys(value)) {
            const member = schema.find(item => item.name === name);
            if (!member) fail("value", `${path}.${name}`, "An undeclared Structure field cannot be retained.");
            const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
            if (!("value" in descriptor)) fail("value", `${path}.${name}`, "A Structure getter cannot be captured.");
            budget.add(stringBytes(name) + 2, path);
            Object.defineProperty(result, name, { value: typed(descriptor.value, member, `${path}.${name}`, depth + 1), enumerable: true, configurable: true, writable: true });
          }
          return result;
        }
        if (field.type === "enum") {
          const members = field.typeClassId ? input.enumMembers?.(field.typeClassId) : null;
          if (!members) fail("resource", path, `Enum ${field.typeClassId ?? "(unspecified)"} has no prepared authoring schema.`);
          if (typeof value !== "string" || !members.includes(value)) fail("value", path, "The reflected Enum value has no authored member.");
        }
        if (field.type === "tag" && (typeof value !== "number" || value < 0 || value > 0xffffffff)) fail("value", path, "The reflected Tag ID is invalid.");
        if (["float", "int", "tag"].includes(field.type) && (typeof value !== "number" || (field.type !== "float" && !Number.isInteger(value)))) fail("value", path, "A reflected numeric variable has an invalid value.");
        if (field.type === "bool" && typeof value !== "boolean") fail("value", path, "A reflected Boolean variable has an invalid value.");
        if (["string", "class", "asset"].includes(field.type) && typeof value !== "string") fail("value", path, "A reflected identity or text variable has an invalid value.");
        if (field.type === "asset" && typeof value === "string" && value && !input.assetExists(value)) fail("resource", path, `Asset ${value} is not available to the authored scene.`);
        if (field.type === "class" && typeof value === "string" && value && !input.world.classRegistry.has(value)) fail("resource", path, `Class ${value} has no authored schema.`);
        if (field.type === "object" && field.typeClassId && value instanceof BObject && !input.world.classRegistry.isA(value.classId, field.typeClassId)) fail("reference", path, "The object reference has the wrong Class.");
        if (field.type === "object" && !(value instanceof Actor) && !(value instanceof ActorComponent)) fail("resource", path, "Only scene Actor and Component object references can be retained.");
      }
      return encode(value, path);
    };

    const fieldsFor = (object: BObject, base: Record<string, unknown>): Map<string, Field> => {
      const fields = new Map<string, Field>(Object.keys(base).map((name) => [name, { type: "data", defaultValue: base[name] }]));
      for (const classId of [...input.world.classRegistry.ancestry(object.classId)].reverse()) {
        for (const variable of engineScriptApiFor(classId)?.variables ?? []) {
          if (!variable.getOnly) fields.set(variable.propertyKey, { ...fields.get(variable.propertyKey), type: variable.typeId, typeClassId: variable.typeClassId, container: variable.container });
        }
      }
      for (const variable of input.world.classRegistry.inheritedVariables(object.classId)) fields.set(variable.name, variable as VariableDef);
      return fields;
    };
    const actorIds = new Map([...byGuid].map(([guid, actor]) => [guid, references.get(actor)!.actorId]));
    // Match the persisted scene codec's explicit identity fields, with ownership
    // validation. Work only on encoded authorable data, never live runtime maps.
    const remapProperties = (value: Record<string, unknown>, actor: Actor): Record<string, unknown> => {
      const targetId = value.targetActorId;
      const target = typeof targetId === "string" && targetId ? byGuid.get(targetId) : actor;
      const componentIds = new Map((target?.components ?? []).filter(component => references.has(component)).map(component => [component.guid, references.get(component)!.componentId!]));
      const remap = (entry: unknown, path: string): unknown => {
        if (!entry || typeof entry !== "object" || Object.hasOwn(entry, "$sceneValue")) return entry;
        if (Array.isArray(entry)) return entry.map((item, index) => remap(item, `${path}[${index}]`));
        const row = entry as Record<string, unknown>;
        const typedReference = typeof row.classId === "string" || row.kind === "actorRef" || row.kind === "objectRef";
        return Object.fromEntries(Object.entries(row).map(([key, item]) => {
          const typedId = typedReference && (key === "guid" || key === "id");
          const componentId = /Component(?:Id|Guid)$/.test(key) || key === "componentId" || key === "componentGuid"
            || (typedId && row.kind !== "actorRef" && typeof row.classId === "string" && row.classId.endsWith("Component"));
          const actorId = /Actor(?:Id|Guid)$/.test(key) || key === "actorId" || key === "actorGuid" || typedId;
          if ((componentId || actorId) && typeof item === "string" && item) {
            const mapped = componentId ? componentIds.get(item) : actorIds.get(item);
            if (!mapped) fail("reference", `${path}.${key}`, `Scene reference ${item} is unavailable.`);
            return [key, mapped];
          }
          if (key === "actorIds" && Array.isArray(item)) return [key, item.map(id => {
            if (typeof id !== "string" || !actorIds.has(id)) fail("reference", `${path}.${key}`, "An actor reference is unavailable.");
            return actorIds.get(id)!;
          })];
          return [key, remap(item, `${path}.${key}`)];
        }));
      };
      return remap(value, actor.guid) as Record<string, unknown>;
    };
    const properties = (object: BObject, base: Record<string, unknown>, defaults: Record<string, unknown>, path: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      const fields = fieldsFor(object, { ...defaults, ...base });
      const inheritedDefaults = new Set(input.world.classRegistry.inheritedVariables(object.classId).map(variable => variable.name));
      for (const [name, field] of fields) {
        if (!object.variables.has(name)) continue;
        const current = object.getVariable(name);
        const value = typed(current, field, `${path}.${name}`);
        if (!Object.hasOwn(base, name) && field.defaultValue !== undefined && same(value, field.defaultValue)
          && (object instanceof Actor || inheritedDefaults.has(name))) continue;
        Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
      }
      return remapProperties(result, object instanceof Actor ? object : (object as ActorComponent).owner!);
    };
    const transform = (value: Transform, path: string): SerializedTransform => encode({
      position: [value.position.x, value.position.y, value.position.z],
      rotation: [value.rotation.x, value.rotation.y, value.rotation.z, value.rotation.w],
      scale: [value.scale.x, value.scale.y, value.scale.z],
    }, path) as SerializedTransform;
    const parentActorId = (actor: Actor): string | null => {
      const parent = actor.getVariable("parentId");
      if (parent === null || parent === undefined || parent === "") return null;
      if (typeof parent !== "string") fail("reference", actor.guid, "Actor parent identity is invalid.");
      const target = byGuid.get(parent);
      if (!target || !references.has(target)) fail("reference", actor.guid, `Actor parent ${parent} is unavailable.`);
      return references.get(target)!.actorId;
    };
    const actors: SerializedActor[] = [];
    for (const actor of live) {
      const id = references.get(actor)!.actorId, before = beforeById.get(id);
      const templates = input.prefabComponents(actor.classId);
      const components: SerializedComponent[] = [];
      const sourceIds = new Set<string>();
      for (const component of actor.components) {
        if (component.destroyed) continue;
        const componentId = references.get(component)!.componentId!;
        const previous = before?.components.find((entry) => entry.id === componentId);
        if (component.classId === "DynamicRuntimeMeshComponent") fail("resource", `${id}.${componentId}`, "Dynamic Runtime Mesh geometry has no authored resource representation.");
        const template = component.sourceId ? templates.find((entry) => entry.id === component.sourceId) : undefined;
        if (component.sourceId && !previous && !template) fail("reference", componentId, "The source prefab component is unavailable for instance override capture.");
        const row: SerializedComponent = {
          id: componentId, classId: component.classId,
          properties: properties(component, previous?.properties ?? {}, defaultComponentAuthoringProperties(component.classId, input.baseline.settings.physicsWorld, input.baseline.viewportMode), `${id}.${componentId}`),
          parentId: null,
          ...(component.classId === "2DAnchorComponent" ? {} : { transform: transform(component.transform, `${id}.${componentId}.transform`) }),
        };
        if (component.parentId) {
          const parent = actor.components.find((entry) => entry.guid === component.parentId && !entry.destroyed);
          if (!parent || !references.has(parent)) fail("reference", componentId, `Component parent ${component.parentId} is unavailable.`);
          row.parentId = references.get(parent)!.componentId!;
        }
        if (component.sourceId) {
          if (sourceIds.has(component.sourceId)) fail("reference", componentId, "Multiple components claim the same prefab source identity.");
          sourceIds.add(component.sourceId); row.sourceId = component.sourceId;
          const source = previous ?? template!;
          const overrides = new Set(previous?.overrideKeys ?? []);
          for (const name of new Set([...Object.keys(row.properties), ...Object.keys(source.properties)])) if (!same(row.properties[name], source.properties[name])) overrides.add(name);
          if (!same(row.transform, source.transform)) overrides.add("transform");
          const sourceParent = previous ? source.parentId : components.find(entry => entry.sourceId === source.parentId)?.id
            ?? actor.components.filter(entry => !entry.destroyed).map(entry => ({ sourceId: entry.sourceId, id: references.get(entry)?.componentId })).find(entry => entry.sourceId === source.parentId)?.id;
          if (row.parentId !== (sourceParent ?? null)) overrides.add("parentId");
          if (overrides.size) row.overrideKeys = [...overrides];
        }
        const material = component.getVariable("materialGuid");
        if (typeof material === "string" && material) {
          if (!input.assetExists(material)) fail("resource", componentId, `Material asset ${material} is unavailable.`);
          const overrides = input.materialOverrides(component);
          if (overrides === null) fail("resource", componentId, "The effective material parameter state cannot be captured.");
          for (const [name, parameter] of Object.entries(overrides)) {
            if (parameter.kind === "texture" && parameter.textureAssetGuid && !input.assetExists(parameter.textureAssetGuid)) fail("resource", `${componentId}.materialInstance.${name}`, `Texture asset ${parameter.textureAssetGuid} is unavailable.`);
          }
          if (Object.keys(overrides).length) row.materialInstance = { materialGuid: material, parameters: encode(overrides, `${componentId}.materialInstance`) as Record<string, MaterialParameterValue> };
          if (!same(row.materialInstance, previous?.materialInstance) && component.sourceId) row.overrideKeys = [...new Set([...(row.overrideKeys ?? []), "materialInstance"])];
        }
        components.push(row);
      }
      const suppressed = new Set(before?.suppressedComponentSourceIds ?? actor.suppressedComponentSourceIds);
      for (const component of before?.components ?? templates) {
        const source = before ? component.sourceId : component.id;
        if (source && !sourceIds.has(source)) suppressed.add(source);
      }
      for (const sourceId of sourceIds) suppressed.delete(sourceId);
      const actorProperties = properties(actor, before?.properties ?? {}, {}, `${id}.properties`);
      const runtimeName = actor.getVariable("name");
      if (!before && runtimeName !== undefined && typeof runtimeName !== "string") fail("value", `${id}.name`, "Actor name is not a string.");
      const visible = actor.getVariable("visible");
      if (visible !== undefined && typeof visible !== "boolean") fail("value", `${id}.visible`, "Actor visibility is not a Boolean.");
      actors.push({
        id, classId: actor.classId, name: (runtimeName as string | undefined) ?? before?.name ?? actor.classId,
        parentId: parentActorId(actor), transform: transform(actor.transform, `${id}.transform`),
        visible: visible !== false, locked: before?.locked ?? false, folderId: before?.folderId ?? null, components,
        ...(Object.keys(actorProperties).length || before?.properties ? { properties: actorProperties } : {}),
        ...(suppressed.size ? { suppressedComponentSourceIds: [...suppressed] } : {}),
        ...(before?.prefabGuid ? { prefabGuid: before.prefabGuid } : {}),
      });
    }
    const scene: SerializedScene = {
      name: input.baseline.name, viewportMode: input.baseline.viewportMode,
      settings: encode(input.sceneSettings, "scene.settings") as SceneSettings,
      folders: encode(input.baseline.folders, "scene.folders") as SerializedScene["folders"], actors,
      ...(input.baseline.overlayEditor !== undefined ? { overlayEditor: input.baseline.overlayEditor } : {}),
    };
    // Validate hierarchy before a normalizer can silently repair it.
    const checkParents = (rows: readonly { id: string; parentId?: string | null }[], path: string) => {
      const map = new Map(rows.map((row) => [row.id, row.parentId ?? null]));
      for (const row of rows) {
        const seen = new Set<string>([row.id]);
        let parent = row.parentId;
        while (parent) {
          if (seen.has(parent) || !map.has(parent)) fail("reference", path, "Captured hierarchy contains a cycle or missing parent.");
          seen.add(parent); parent = map.get(parent);
        }
      }
    };
    checkParents(actors, "scene.actors");
    for (const actor of actors) checkParents(actor.components, actor.id);
    // A deleted default camera has the scene schema's documented None value.
    if (scene.settings.mainCameraActorId && !actors.some((actor) => actor.id === scene.settings.mainCameraActorId && actor.components.some((component) => component.id === scene.settings.mainCameraComponentId))) {
      scene.settings.mainCameraActorId = null; scene.settings.mainCameraComponentId = null;
    }
    // Exact final JSON accounting without materializing a full JSON string.
    const measured = new Budget(budget.maxBytes, budget.maxNodes);
    const measure = (value: unknown, path: string): void => {
      if (value === null) { measured.add(4, path); return; }
      if (typeof value === "string") { measured.add(stringBytes(value), path); return; }
      if (typeof value === "number" || typeof value === "boolean") { measured.add(String(value).length, path); return; }
      if (Array.isArray(value)) { measured.add(2 + Math.max(0, value.length - 1), path); for (const entry of value) measure(entry, path); return; }
      const entries = Object.entries(value as Record<string, unknown>);
      measured.add(2 + Math.max(0, entries.length - 1), path);
      for (const [key, entry] of entries) { measured.add(stringBytes(key) + 1, path); measure(entry, `${path}.${key}`); }
    };
    measure(scene, "scene");
    // Normalization may add schema defaults, but must never repair/drop a captured
    // value. Check before returning its canonical result to the edit transaction.
    const canonical = normalizeScene(scene);
    if (scene.overlayEditor !== undefined) canonical.overlayEditor = scene.overlayEditor;
    const preserves = (captured: unknown, normalized: unknown, path: string): void => {
      if (captured === null || typeof captured !== "object") {
        if (!Object.is(captured, normalized)) fail("value", path, "Captured state cannot round-trip through the scene authoring codec.");
        return;
      }
      if (normalized === null || typeof normalized !== "object" || Array.isArray(captured) !== Array.isArray(normalized)) fail("value", path, "Captured state has no matching scene authoring codec.");
      if (Array.isArray(captured) && captured.length !== (normalized as unknown[]).length) fail("value", path, "A captured scene array would lose entries on load.");
      for (const [key, entry] of Object.entries(captured)) {
        if (!Object.hasOwn(normalized, key)) fail("value", `${path}.${key}`, "A captured authorable field would be lost on load.");
        preserves(entry, (normalized as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    preserves(scene, canonical, "scene");
    measured.bytes = 0; measured.nodes = 0;
    measure(canonical, "scene");
    return { ok: true, scene: canonical, identity, byteSize: measured.bytes };
  } catch (error) {
    if (error instanceof CaptureFailure) return { ok: false, code: error.code, reason: error.message, path: error.path, identity };
    return { ok: false, code: "value", reason: error instanceof Error ? error.message : "Scene capture failed.", path: "scene", identity };
  }
}
