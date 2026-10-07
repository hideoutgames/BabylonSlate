import {
  areaEmissionTextureGuids,
  consoleCommandMetadataFromGraph,
  type ConsoleCommandMetadata,
  assetVariableGuidsFromGraph,
  isLegacyMaterialAssetType,
  materialParameterTextureGuidsFromGraph,
  normalizeMaterialInstanceOverrides,
  parseMapDefaultEntries,
  renderTargetAssetGuidsFromGraph,
  richTextImageGuids,
  type GraphClassMember,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  materialDependencies,
  materialInstanceDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
} from "@babylonslate/shader-graph";
import { animationAssetGuids } from "./animation-payload";
import { audioAssetDependencies } from "./audio-payload";
import type { BabassetHeader } from "./babasset";
import { dataAssetDependencies, dataGraphAssetDependencies, type DataDefinitionFieldsResolver } from "./data-asset-refs";
import { modelAssetGuids } from "./model-payload";
import { particleAssetDependencies } from "./particle-payload";
import { skeletonAssetGuids } from "./skeleton-payload";
import { skyboxCreatorAssetDependencies } from "./skybox-creator-payload";
import { parseSpriteAnimationPayload, spriteAnimationTextureGuids } from "./sprite-animation-payload";

export const ASSET_DEPENDENCY_METADATA_VERSION = 1;

export interface AssetDependencyMetadata {
  dependencyMetadataVersion: number;
  /** Every declared reference, including later gameplay and editor previews. */
  dependencies: string[];
  /** Only resources needed to prepare this consumer now. */
  requiredDependencies: string[];
  /** Typed Class identities can be resolved from a catalog when no GUID context was supplied. */
  classReferences?: string[];
  requiredClassReferences?: string[];
  consoleCommand?: ConsoleCommandMetadata;
  /** Class property keys required by synchronous graph consumers. */
  requiredVariableNames?: string[];
}

export class DependencyMetadataUpgradeRequiredError extends Error {
  readonly code = "dependency-metadata-upgrade-required";
  readonly assetGuid: string;
  readonly metadataVersion?: number;
  constructor(assetGuid: string, metadataVersion?: number) {
    super(`Asset ${assetGuid} has dependency metadata version ${metadataVersion ?? "legacy"}; run the explicit dependency metadata upgrade before loading it.`);
    this.name = "DependencyMetadataUpgradeRequiredError";
    this.assetGuid = assetGuid;
    this.metadataVersion = metadataVersion;
  }
}

export function getRequiredDependencies(header: Pick<BabassetHeader, "guid" | "dependencyMetadataVersion" | "requiredDependencies">): readonly string[] {
  if (header.dependencyMetadataVersion !== ASSET_DEPENDENCY_METADATA_VERSION || !header.requiredDependencies) {
    throw new DependencyMetadataUpgradeRequiredError(header.guid, header.dependencyMetadataVersion);
  }
  return header.requiredDependencies;
}

export interface AssetDependencyClass {
  guid: string;
  classId: string;
  parentClassId?: string | null;
  members?: readonly GraphClassMember[];
  requiredVariableNames?: readonly string[];
}

export interface AssetDependencyPin {
  id: string;
  name: string;
  direction?: string;
  type: unknown;
  defaultValue?: unknown;
}

export interface AssetDependencyContext {
  /** Additional declared dynamic references. Unknown relationships remain deferred. */
  dependencies?: readonly string[];
  parentClass?: string | null;
  classes?: readonly AssetDependencyClass[];
  definitionFields?: DataDefinitionFieldsResolver;
  /** Authoring hosts supply their node catalog; no scripting dependency enters assets. */
  graphPins?: (type: string, properties: Record<string, unknown>) => readonly AssetDependencyPin[] | undefined;
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

// Legacy graphs may omit canvas pin snapshots. Dynamic pins use host schemas.
const BUILTIN_ASSET_PINS: Readonly<Record<string, readonly string[]>> = {
  "literal.makeAsset": ["in", "In"],
  "audio.play": ["asset", "asset"],
  "audio.setChannelVolume": ["channel", "channel"],
  "scene.change": ["scene", "scene"],
  "scene-layer.create": ["asset", "Asset"],
  "scene-layer.registerPostProcess": ["material", "Material"],
  "scene-layer.unregisterPostProcess": ["material", "Material"],
  "material.setMaterialInstance": ["instance", "Instance"],
  "material.setTextureParameter": ["value", "Value"],
  "render-target.getMode": ["target", "Render Target"],
  "render-target.getTextureTarget": ["texture", "Texture"],
  "render-target.setRenderTarget": ["value", "Render Target"],
  "assets.getLoadState": ["asset", "Asset"],
};

/** Typed fields, never a recursive search for arbitrary strings resembling GUIDs. */
const COMPONENT_ASSET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  MeshComponent: ["assetGuid", "materialGuid"],
  DynamicRuntimeMeshComponent: ["materialGuid"],
  CableComponent: ["materialGuid"],
  SpriteComponent: ["assetGuid", "materialGuid"],
  TilemapComponent: ["assetGuid", "materialGuid"],
  LandscapeComponent: ["materialGuid"],
  AreaRectLightComponent: ["textureGuid"],
  RenderTargetCaptureComponent: ["renderTargetGuid"],
  Text3DComponent: ["fontAssetGuid", "materialGuid"],
  AudioComponent: ["audioAssetGuid", "audioChannelGuid", "soundAttenuationGuid"],
  ParticleComponent: ["assetGuid", "particleSystemGuid"],
  AnimationGraphComponent: ["assetGuid", "graphGuid"],
  BehaviourTreeComponent: ["assetGuid", "treeGuid"],
  SaveGameComponent: ["definitionGuid"],
  GlobalWaterVolumeComponent: ["waterGuid", "assetGuid"],
  WaterOceanComponent: ["waterGuid", "assetGuid"],
  WaterLakeComponent: ["waterGuid", "assetGuid"],
  WaterRiverComponent: ["waterGuid", "assetGuid"],
  WaterPuddleComponent: ["waterGuid", "assetGuid"],
  "2DMaterialComponent": ["materialGuid"],
  "2DTextureComponent": ["textureGuid", "assetGuid"],
  "2DPanelComponent": ["textureGuid", "materialGuid"],
  "2DTextComponent": ["fontAssetGuid", "materialGuid"],
  "2DRichTextComponent": ["fontAssetGuid", "materialGuid"],
  "2DJoystickComponent": ["backgroundMaterialGuid", "joystickMaterialGuid", "backgroundTextureGuid", "joystickTextureGuid"],
};

/**
 * Collect both graphs in the same pass. Required wins when a GUID occurs in both
 * roles: e.g. a visible mesh and a prefab variable may reference the same model.
 */
export function collectAssetDependencyMetadata(assetType: string, payload: Row, context: AssetDependencyContext = {}): AssetDependencyMetadata {
  const all = new Set<string>();
  const required = new Set<string>();
  const requiredVariableNames = new Set<string>();
  const classReferences = new Set<string>();
  const requiredClassReferences = new Set<string>();
  const add = (value: unknown, needed = true): void => {
    if (typeof value !== "string" || !value.trim() || value.startsWith("engine:")) return;
    const guid = value.trim();
    all.add(guid);
    if (needed) required.add(guid);
  };
  const addMany = (entries: readonly unknown[], needed = true): void => entries.forEach(value => add(value, needed));
  addMany(context.dependencies ?? [], false);
  const classes = context.classes ?? [];
  const classMap = new Map(classes.flatMap(entry => [[entry.guid, entry], [entry.classId, entry]] as const));
  const addClass = (id: unknown, needed = true): void => {
    if (typeof id !== "string" || !id.trim()) return;
    id = id.trim();
    classReferences.add(id as string);
    if (needed) requiredClassReferences.add(id as string);
    const entry = classMap.get(id as string);
    if (entry) add(entry.guid, needed);
    else if ((id as string).startsWith("scene:")) add((id as string).slice(6), needed);
  };

  const typeValue = (type: unknown, value: unknown, needed = false, seen = new Set<string>(), schemaNeeded = true): void => {
    const spec = row(type);
    if (spec.kind === "assetRef") add(value, needed);
    else if (spec.kind === "classRef") { addClass(spec.classId, false); addClass(value, needed); }
    else if (spec.kind === "actorRef" || spec.kind === "objectRef") addClass(spec.classId, false);
    else if (spec.kind === "enumRef" || spec.kind === "structRef") {
      add(spec.guid, schemaNeeded);
      if (spec.kind === "structRef" && spec.guid === "engine:InputType") add(row(value).Asset, needed);
      else if (spec.kind === "structRef" && spec.guid === "engine:InputBinding") add(row(row(value).Input).Asset, needed);
      else if (spec.kind === "structRef" && typeof spec.guid === "string" && !seen.has(spec.guid)) {
        const next = new Set(seen).add(spec.guid);
        for (const field of context.definitionFields?.(spec.guid) ?? []) {
          const descriptor = row(field);
          memberValue(descriptor, row(value)[String(descriptor.name)], needed, next, schemaNeeded);
        }
      }
    } else if (spec.kind === "array") {
      typeValue(spec.element, undefined, needed, seen, schemaNeeded);
      values(value).forEach(entry => typeValue(spec.element, entry, needed, seen, schemaNeeded));
    } else if (spec.kind === "map") {
      typeValue(spec.key, undefined, needed, seen, schemaNeeded);
      typeValue(spec.value, undefined, needed, seen, schemaNeeded);
      for (const entry of parseMapDefaultEntries(value)) {
        typeValue(spec.key, entry.key, needed, seen, schemaNeeded);
        typeValue(spec.value, entry.value, needed, seen, schemaNeeded);
      }
    }
  };
  const memberType = (member: Row, key = false): Row => {
    const type = member[key ? "keyTypeId" : "typeId"];
    const id = member[key ? "keyTypeClassId" : "typeClassId"];
    return type === "asset" ? { kind: "assetRef", assetType: id }
      : type === "class" ? { kind: "classRef", classId: id }
        : type === "object" ? { kind: "objectRef", classId: id }
          : type === "struct" ? { kind: "structRef", guid: id }
            : type === "enum" ? { kind: "enumRef", guid: id } : { kind: type };
  };
  const memberValue = (member: Row, value: unknown, needed = false, seen?: Set<string>, schemaNeeded = true): void => {
    const type = memberType(member);
    typeValue(member.container === "array" ? { kind: "array", element: type }
      : member.container === "map" ? { kind: "map", key: memberType(member, true), value: type } : type, value, needed, seen, schemaNeeded);
    for (const field of rows(member.fields)) memberValue(field, row(value)[String(field.name)], needed, seen, schemaNeeded);
    for (const field of rows(member.keyFields)) memberValue(field, undefined, false, seen, schemaNeeded);
    for (const pin of rows(member.pins)) typeValue(memberType(pin), undefined, false);
    add(member.assetGuid, false);
    add(row(member.implementsInterface).assetGuid, false);
    addClass(row(member.overrides).classId, false);
  };
  const instanceProperties = (classId: unknown, properties: Row): void => {
    if (typeof classId !== "string") return;
    const visited = new Set<string>();
    const lineage: AssetDependencyClass[] = [];
    const requiredKeys = new Set<string>();
    let current: string | null | undefined = classId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const definition = classMap.get(current);
      if (!definition) break;
      lineage.push(definition);
      for (const key of definition.requiredVariableNames ?? []) requiredKeys.add(key);
      current = definition.parentClassId;
    }
    for (const definition of lineage) for (const member of definition.members ?? []) if (member.kind === "variable" && !member.functionId) {
      const key = member.propertyKey ?? member.name;
      memberValue(member as unknown as Row, Object.hasOwn(properties, key) ? properties[key] : member.defaultValue,
        requiredKeys.has(key) || requiredKeys.has(member.name));
    }
  };
  const materialParameters = (parameters: unknown, needed = true): void => {
    for (const parameter of Object.values(row(parameters))) {
      const spec = row(parameter);
      if (spec.type === "texture" || spec.kind === "texture") add(spec.textureAssetGuid ?? spec.value ?? spec.textureGuid, needed);
    }
  };
  const components = (entries: unknown): void => {
    for (const component of rows(entries)) {
      addClass(component.classId);
      const properties = row(component.properties);
      const classId = String(component.classId);
      instanceProperties(component.classId, properties);
      const lineage = new Set<string>();
      let current: string | null | undefined = classId;
      while (current && !lineage.has(current)) {
        lineage.add(current);
        for (const field of COMPONENT_ASSET_FIELDS[current] ?? []) add(properties[field]);
        current = classMap.get(current)?.parentClassId;
      }
      materialParameters(properties.materialParameters);
      materialParameters(properties.parameterOverrides);
      // Scene-owned private values follow only the current assignment. Stale
      // overrides must not pull an unrelated material or texture into startup.
      const materialInstance = normalizeMaterialInstanceOverrides(component.materialInstance);
      if (materialInstance && materialInstance.materialGuid === properties.materialGuid) {
        materialParameters(materialInstance.parameters);
      }
      for (const guid of Object.values(row(properties.materialSlotOverrides))) add(guid);
      for (const slot of rows(properties.materialSlots)) add(slot.materialGuid);
      if (lineage.has("SceneStreamingComponent")) add(properties.sceneGuid, false);
      if (classId === "SkyboxComponent") for (const face of ["px", "py", "pz", "nx", "ny", "nz"]) add(row(properties.faces)[face]);
      if (classId === "FoliageComponent") for (const batch of rows(properties.batches)) { add(batch.modelGuid); add(batch.materialGuid); }
      if (classId === "2DTextComponent" || classId === "2DRichTextComponent") {
        if (typeof properties.text === "string") addMany(richTextImageGuids(properties.text));
      }
      if (classId.startsWith("2D")) {
        for (const part of ["background", "track", "fill", "thumb", "handle", "selection", "indicator", "check", "arrow", "button", "popup", "item"]) {
          add(properties[`${part}MaterialGuid`]); add(properties[`${part}TextureGuid`]);
        }
      }
    }
  };
  const graph = (input: unknown): void => {
    const source = row(input);
    const serialized = source as unknown as SerializedGraph;
    addMany(assetVariableGuidsFromGraph(serialized), false);
    addMany(materialParameterTextureGuidsFromGraph({ ...serialized, nodes: serialized.nodes ?? [] }), false);
    addMany(renderTargetAssetGuidsFromGraph({ ...serialized, nodes: serialized.nodes ?? [] }), false);
    addMany(dataGraphAssetDependencies(source, classes, context.definitionFields), false);
    for (const member of rows(source.members)) memberValue(member, member.defaultValue);
    for (const slice of [source, ...Object.values(row(source.functionGraphs)).map(row)]) {
      const nodes = rows(slice.nodes).map(node => {
        const data = row(node.data);
        const properties = row(data.properties ?? node.properties ?? data);
        const nodeType = String(data.__nodeType ?? node.type ?? node.typeId);
        const pins = context.graphPins?.(nodeType, properties) ?? rows(data.__pins ?? data.pins) as unknown as AssetDependencyPin[];
        return { node, properties, nodeType, pins };
      });
      const requiredNodes = new Set<string>();
      const byId = new Map(nodes.map(node => [String(node.node.id), node]));
      const incoming = rows(slice.edges);
      const requireInputs = (id: string): void => {
        if (requiredNodes.has(id)) return;
        requiredNodes.add(id);
        for (const edge of incoming) if ((edge.target ?? edge.targetNodeId) === id) {
          const handle = String(edge.targetHandle ?? edge.targetPinId ?? "");
          const pin = byId.get(id)?.pins.find(pin => pin.id === handle || pin.name === handle);
          if (row(pin?.type).kind === "exec" || /^exec/i.test(handle)) continue;
          requireInputs(String(edge.source ?? edge.sourceNodeId));
        }
      };
      for (const entry of nodes) if (entry.nodeType.startsWith("input.") ||
        ["data.readEntry", "data.getChildren", "data.getDescendants", "data.getParent"].includes(entry.nodeType)) requireInputs(String(entry.node.id));
      for (const { node, properties, nodeType, pins } of nodes) {
        const needed = requiredNodes.has(String(node.id));
        const schemaNeeded = nodeType !== "data.readEntryAsync";
        for (const pin of pins) {
          const explicit = [`default:${pin.id}`, pin.id, `default:${pin.name}`, pin.name].map(key => properties[key]).find(entry => entry !== undefined);
          const value = explicit === undefined ? pin.defaultValue : explicit;
          typeValue(pin.type, pin.direction === "out" ? undefined : value, needed, undefined, schemaNeeded);
        }
        if (!pins.length) {
          const names = BUILTIN_ASSET_PINS[nodeType];
          if (names) add([`default:${names[0]}`, names[0]!, `default:${names[1]}`, names[1]!]
            .map(key => properties[key]).find(value => value !== undefined), needed);
          if (nodeType === "assets.preload") addMany(values(properties["default:assets"] ?? properties.assets ?? properties["default:Assets"]), false);
          if (nodeType === "literal.makeClass") addClass(properties["default:in"] ?? properties.in ?? properties["default:In"], needed);
        }
        if (nodeType.startsWith("data.")) {
          add(properties["default:tree"] ?? properties.tree ?? properties["default:Tree"], needed);
          add(properties.definitionGuid, schemaNeeded);
          for (const field of rows(properties.dataSchema)) memberValue(field, undefined, false, undefined, schemaNeeded);
        }
        if (nodeType === "variables.get" && needed) {
          const inherited: Row[] = [];
          const visited = new Set<string>();
          let parent = context.parentClass;
          while (parent && !visited.has(parent)) {
            visited.add(parent);
            const definition = classMap.get(parent);
            inherited.push(...(definition?.members ?? []).map(member => member as unknown as Row));
            parent = definition?.parentClassId;
          }
          const member = [...rows(source.members), ...inherited].find(member =>
            (properties.memberId !== undefined && member.id === properties.memberId) ||
            (properties.propertyKey !== undefined && (member.propertyKey ?? member.name) === properties.propertyKey) ||
            (properties.variableName !== undefined && member.name === properties.variableName));
          const key = properties.propertyKey ?? member?.propertyKey ?? properties.variableName ?? member?.name;
          if (typeof key === "string" && key) requiredVariableNames.add(key);
          if (member) memberValue(member, member.defaultValue, true);
        }
        // Native input structures remain typed even when old graphs lack pin snapshots.
        for (const value of Object.values(properties)) {
          const input = row(value);
          if (typeof input.Name === "string" && typeof input.Asset === "string") add(input.Asset, needed);
          if (typeof row(input.Input).Asset === "string") add(row(input.Input).Asset, needed);
        }
        for (const key of ["classId", "classRef", "actorClass", "componentClass"]) addClass(properties[`default:${key}`] ?? properties[key], nodeType === "functions.call");
      }
    }
  };

  addMany(audioAssetDependencies(assetType, payload));
  addMany(particleAssetDependencies(assetType, payload));
  if (assetType === "Material" || isLegacyMaterialAssetType(assetType) || assetType === "MaterialFunction") {
    const document = assetType === "MaterialFunction" ? normalizeMaterialFunctionDocument(payload) : normalizeMaterialDocument(payload);
    const refs = materialDependencies(document);
    addMany(refs.textures); addMany(refs.functions); addMany(refs.meshes, false);
  } else if (assetType === "MaterialInstance") addMany(materialInstanceDependencies(normalizeMaterialInstanceDocument(payload)).all);
  else if (assetType === "Model") addMany(modelAssetGuids(payload));
  else if (assetType === "Skeleton") addMany(skeletonAssetGuids(payload));
  else if (assetType === "Animation") addMany(animationAssetGuids(payload));
  else if (assetType === "SpriteAnimation") addMany(spriteAnimationTextureGuids(parseSpriteAnimationPayload(payload)));
  else if (assetType === "Sprite" || assetType === "Tileset") add(payload.textureGuid);
  else if (assetType === "Tilemap") { add(payload.tilesetGuid); for (const tileset of rows(payload.tilesets)) add(tileset.guid); }
  else if (assetType === "Font") addMany(values(payload.fallbackGuids));
  else if (assetType === "Water") add(payload.materialGuid);
  else if (assetType === "RenderTargetTexture") add(payload.renderTargetGuid);
  else if (assetType === "SkyboxCreator") addMany(skyboxCreatorAssetDependencies(assetType, payload), false);
  else if (["DataDefinition", "DataTree", "Structure", "Enum"].includes(assetType)) {
    // Data values describe available assets, not automatically instantiated consumers.
    addMany(dataAssetDependencies(assetType, payload, classes, context.definitionFields), false);
    for (const field of rows(payload.fields)) memberValue(field, field.defaultValue);
    if (assetType === "DataTree") {
      add(payload.defaultDefinitionGuid);
      for (const entry of rows(payload.entries)) {
        add(entry.definitionGuid);
        for (const field of rows(entry.schema)) memberValue(field, row(entry.values)[String(field.name)]);
      }
    }
  } else if (assetType === "Scene" || assetType === "SceneLayer") {
    const settings = row(payload.settings);
    add(settings.environmentTextureGuid);
    addClass(settings.gameInstanceClass);
    for (const pass of rows(settings.postProcessStack)) { add(pass.materialGuid, pass.enabled !== false); materialParameters(pass.parameters, pass.enabled !== false); }
    for (const layer of rows(settings.sceneLayers)) add(layer.assetGuid, layer.enabled !== false);
    for (const group of rows(settings.foliageGroups)) for (const model of rows(group.models)) { add(model.modelGuid, false); add(model.materialGuid, false); }
    for (const actor of rows(payload.actors)) {
      addClass(actor.classId);
      // Prefab components are baked into the actor, so the Prefab is editor-only.
      add(actor.prefabGuid, false);
      instanceProperties(actor.classId, row(actor.properties));
      for (const entry of values(row(actor.properties).sceneLayerActors)) {
        addClass(typeof entry === "string" ? entry : row(entry).classId, false);
        instanceProperties(row(entry).classId, row(row(entry).defaults));
      }
      components(actor.components);
    }
  } else if (assetType === "Class" || assetType === "Graph") {
    addClass(context.parentClass);
    components(payload.components);
    graph(payload);
    addMany(areaEmissionTextureGuids(payload), false);
  } else if (assetType === "Prefab") {
    components(payload.components);
    addMany(areaEmissionTextureGuids(payload), false);
  } else if (assetType === "AnimationGraph") {
    for (const clip of rows(payload.clips)) add(clip.assetGuid);
    for (const transition of rows(payload.transitions)) graph(transition.ruleGraph);
    graph(payload.animationObject);
    for (const variable of rows(payload.variables)) memberValue(variable, variable.defaultValue);
  } else if (assetType === "BehaviourTree") {
    add(payload.blackboardGuid);
    for (const node of rows(payload.nodes)) for (const entry of [node, ...rows(node.decorators), ...rows(node.services)]) {
      addClass(entry.classId); instanceProperties(entry.classId, row(entry.properties));
    }
  } else if (assetType === "Blackboard") for (const key of rows(payload.keys)) typeValue(key.type, key.defaultValue);
  else if (assetType === "SaveGame") for (const field of rows(payload.fields)) {
    if (field.type === "asset") addMany(Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue], false);
  }
  else if (assetType === "ScriptInterface") for (const method of rows(payload.methods)) for (const pin of rows(method.pins)) typeValue(memberType(pin), undefined, false);
  else if (assetType === "PluginSettings") for (const dependency of rows(payload.pluginDependencies)) add(dependency.guid);
  return { dependencyMetadataVersion: ASSET_DEPENDENCY_METADATA_VERSION, dependencies: [...all].sort(), requiredDependencies: [...required].sort(),
    classReferences: [...classReferences].sort(), requiredClassReferences: [...requiredClassReferences].sort(),
    ...(["Class", "Graph"].includes(assetType) ? { consoleCommand: consoleCommandMetadataFromGraph(payload) } : {}),
    ...(["Class", "Graph"].includes(assetType) ? { requiredVariableNames: [...requiredVariableNames].sort() } : {}) };
}
