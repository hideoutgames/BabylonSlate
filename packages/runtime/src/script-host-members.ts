import {
  assetLoadStateName,
  cloneSaveGameValue,
  combineRotators,
  createDefaultRenderTargetCaptureProperties,
  deltaRotator,
  formatValue,
  inverseQuat,
  inverseRotator,
  lerpRotator,
  lookAtRotator,
  multiplyQuats,
  normalizeQuat,
  quatRotateVector,
  quatToRotator,
  rotatorForward,
  rotatorRight,
  rotatorToQuat,
  rotatorUp,
  SaveGameError,
  SCENE_LAYER_DEFAULT_CAMERA,
  slerpQuats,
  type Rng,
  type SaveGameResult,
  type SaveGameValue,
  type SceneLayerCamera,
} from "@haptic/core";
import { Actor, EngineObject, MaterialObject, PostProcessMaterialObject, Scene, SceneLayer } from "@haptic/object-model";
import { isInfiniteLoopError } from "@haptic/debugger";
import { EMPTY_ASSET_CATALOG } from "./asset-catalog";
import { captureActorReferences, captureComponent, captureProperties, setCaptureProperty } from "./render-targets";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ComponentFunctionHost } from "./script-component-functions";
import type { HostContextMembers } from "./script-context-types";
import {
  animationGraphComponentOf,
  asActor,
  asActorComponent,
  cameraComponentOf,
  clamp01,
  componentsOfType,
  lightComponentOf,
  readActorLink,
  refuseParentCycle,
  requireSaveGameService,
  sceneLayerGuidOf,
  setActorLink,
} from "./script-host-helpers";
import type { ScriptHostServices } from "./script-host-services";
import type { ScriptMaterialOwnership } from "./script-material-ownership";
import { scriptValuesEqual } from "./script-values-equal";

/** What `createHostMembers` reads from its `ScriptHost`. */
export interface HostMembersHost extends ComponentFunctionHost {
  readonly rng: Rng;
  readonly materials: ScriptMaterialOwnership;
  /** Read on each call because `setBreakpoints` replaces them after construction. */
  breakpoints(): ScriptBreakpoints | null;
}

/**
 * The members every context inherits: the ones whose behavior depends only on the host (see
 * `HostContextKey`). Built once per host. Their closures must not capture a per-call value, which
 * `createScriptContext` owns; they live in their own module so that a reference to one is a compile error.
 */
export function createHostMembers(host: HostMembersHost): HostContextMembers {
  const services = host.services;
  const unavailable = async <T>(): Promise<SaveGameResult<T>> => ({ ok: false, error: {
    code: "unavailable", message: "Select a default Save Game in Project Settings before using saves.",
  } });
  const readField = (value: SaveGameValue, type?: string, array?: boolean): unknown => {
    if (array && Array.isArray(value)) return value.map((entry) => readField(entry, type));
    return type === "actor" && typeof value === "string" ? (services.resolveSaveActor?.(value) ?? services.findActor?.(value) ?? null) : value;
  };
  const writeField = (value: unknown, type?: string, array?: boolean): SaveGameValue => {
    if (array && Array.isArray(value)) return value.map((entry) => writeField(entry, type));
    return cloneSaveGameValue(type === "actor" && value instanceof Actor ? services.getSaveActorId?.(value) ?? value.guid : value);
  };
  const layerCamera = (layer: EngineObject | string | null | undefined): SceneLayerCamera => {
    const guid = sceneLayerGuidOf(layer);
    return (guid ? services.getSceneLayerCamera?.(guid) : null) ?? SCENE_LAYER_DEFAULT_CAMERA;
  };
  const setLayerCamera = (layer: EngineObject | string | null | undefined, changes: Parameters<NonNullable<ScriptHostServices["setSceneLayerCamera"]>>[1]) => {
    const guid = sceneLayerGuidOf(layer);
    if (guid) services.setSceneLayerCamera?.(guid, changes);
  };
  const vector2 = (value: unknown) => value as { x?: unknown; y?: unknown } | null | undefined;
  const breakpoints = () => {
    const current = host.breakpoints();
    return current === null || current.empty ? null : current;
  };
  const reportAssertion = (message: unknown, detail?: string) => {
    const summary = typeof message === "string" ? message.trim() : "";
    const text = `Assertion failed${summary ? `: ${summary}` : ""}${detail ? ` (${detail})` : ""}`;
    if (services.assertFailed) services.assertFailed(text);
    else services.log("error", "Assert", text);
  };
  const members: HostContextMembers = {
    getSaveData: <TData extends object>() => requireSaveGameService(services).getSaveData() as TData,
    getSaveField: (id, type, array) => readField(requireSaveGameService(services).getField(id), type, array),
    setSaveField: (id, value, type, array) => requireSaveGameService(services).setField(id, writeField(value, type, array)),
    newGame: () => services.saveGame?.newGame() ?? unavailable(),
    saveGame: (options) => services.saveGame?.saveGame(options) ?? unavailable(),
    loadGame: (options) => services.saveGame?.loadGame(options) ?? unavailable(),
    listSaves: (options) => services.saveGame?.listSaves(options) ?? unavailable(),
    deleteSave: (options) => services.saveGame?.deleteSave(options) ?? unavailable(),
    registerSaveActor: (actor, persistentId) => {
      if (!(actor instanceof Actor) || actor.destroyed) throw new SaveGameError("invalid", "Register Save Actor requires a live actor.");
      if (!services.registerSaveActor) throw new SaveGameError("unavailable", "Actor persistence is not available in this host.");
      services.registerSaveActor(actor, persistentId);
    },
    // Read on use: an editor host may rebuild its catalog after a registry change.
    get assetRegistry() { return services.getAssetCatalog?.() ?? EMPTY_ASSET_CATALOG; },
    // Read once per run by instrumented scripts; breakpoints change between runs.
    get breakpoints() { return breakpoints(); },
    formatValue: (value) => formatValue(value),
    checkInfiniteLoop: (location) => {
      try {
        services.checkInfiniteLoop?.();
      } catch (error) {
        if (isInfiniteLoopError(error) && location) error.scriptLocation = location;
        throw error;
      }
    },
    log: (severity, category, message) =>
      services.log(severity, category, message),
    nullAccess: (message) => services.log("error", "Script", message),
    assertFailed: (message, detail) => reportAssertion(message, detail),
    assertEqual: (actual, expected, message) => {
      if (scriptValuesEqual(actual, expected)) return;
      reportAssertion(message, `expected ${formatValue(expected)}, got ${formatValue(actual)}`);
    },
    print: (message, key, duration, color) =>
      services.print(message, key, duration, color),
    drawDebug: (payload) => {
      services.drawDebug?.(payload);
    },
    getPostProcessEntry: (owner, entryId) => {
      if (!(owner instanceof Scene || owner instanceof SceneLayer) || !host.canInvokeOwner(owner) || typeof entryId !== "string" || !entryId.trim()) return null;
      return services.getPostProcessEntry?.(owner, entryId.trim()) ?? null;
    },
    getMaterialFloatParameter: (material, name) => {
      const result = host.materials.getMaterialParameter(material, name, "float");
      return { found: result?.kind === "float", value: result?.kind === "float" ? result.value : 0 };
    },
    getMaterialColorParameter: (material, name) => {
      const result = host.materials.getMaterialParameter(material, name, "color");
      const [x, y, z, w] = result?.kind === "color" ? result.value : [0, 0, 0, 1];
      return { found: result?.kind === "color", value: { x: x!, y: y!, z: z!, w: w! } };
    },
    getMaterialTextureParameter: (material, name) => {
      const result = host.materials.getMaterialParameter(material, name, "texture");
      return { found: result?.kind === "texture", value: result?.kind === "texture" ? result.textureAssetGuid : null };
    },
    resetMaterialFloatParameter: (material, name) => host.materials.resetMaterialParameter(material, name, "float"),
    resetMaterialColorParameter: (material, name) => host.materials.resetMaterialParameter(material, name, "color"),
    resetMaterialTextureParameter: (material, name) => {
      const reset = host.materials.resetMaterialParameter(material, name, "texture");
      // The default texture needs no preload; one an earlier set acquired is released.
      if (reset && (material instanceof MaterialObject || material instanceof PostProcessMaterialObject)) {
        host.materials.retainMaterialPreload(material, `texture:${name.trim()}`, null);
      }
      return reset;
    },
    setMeshMaterial: (component, materialGuid) => {
      const target = asActorComponent(component);
      if (!target || (target.classId !== "MeshComponent" && target.classId !== "DynamicRuntimeMeshComponent") ||
        !host.canInvokeOwner(target)) return null;
      const guid = typeof materialGuid === "string" ? materialGuid.trim() : "";
      if (guid && services.prepareAssets && services.getAssetLoadState?.(guid) !== "ready") {
        throw new Error(`Material ${guid} is not prepared; use Set Material Instance (ctx.setMeshMaterialAsync), or load the Material first with Async Load Asset`);
      }
      host.materials.beginMaterialReplacement(target, "material");
      // Re-applying the asset a preload holds keeps that preload; re-applying the current asset keeps its runtime parameter values.
      host.materials.releaseMaterialPreloadUnlessHolding(target, "material", guid);
      if (target.getVariable("materialGuid") !== guid) {
        const previous = target.getVariable("materialObject");
        if (previous instanceof MaterialObject) host.materials.releaseMaterialPreloads(previous);
        target.setVariable("materialGuid", guid);
        host.applyComponentVariable(target, "materialGuid", guid);
      }
      return (target.getVariable("materialObject") as MaterialObject | null) ?? null;
    },
    getMaterialAsset: (material) =>
      (material instanceof MaterialObject || material instanceof PostProcessMaterialObject) && !material.destroyed
        ? material.materialAssetGuid
        : null,
    setMaterialFloatParameter: (material, name, value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      host.materials.setMaterialParameter(material, name, { kind: "float", value });
    },
    setMaterialColorParameter: (material, name, value) => {
      if (!value || typeof value !== "object") return;
      const rgba: [number, number, number, number] = [
        value.x,
        value.y,
        value.z,
        value.w,
      ];
      if (
        !rgba.every(
          (channel) =>
            typeof channel === "number" && Number.isFinite(channel),
        )
      )
        return;
      host.materials.setMaterialParameter(material, name, {
        kind: "color",
        value: rgba,
      });
    },
    setMaterialTextureParameter: (material, name, value) => {
      if (value !== null && typeof value !== "string") return;
      if (value && services.prepareAssets && services.getAssetLoadState?.(value.trim()) !== "ready") {
        throw new Error(`Texture ${value} is not prepared; use Set Material Texture Parameter (ctx.setMaterialTextureParameterAsync), or load the Texture first with Async Load Asset`);
      }
      const textureAssetGuid = value?.trim() || null;
      if (material instanceof MaterialObject || material instanceof PostProcessMaterialObject) {
        const key = `texture:${name.trim()}`;
        host.materials.beginMaterialReplacement(material, key);
        // Binding the texture a preload holds keeps that preload.
        host.materials.releaseMaterialPreloadUnlessHolding(material, key, textureAssetGuid ?? "");
      }
      host.materials.setMaterialParameter(material, name, { kind: "texture", textureAssetGuid });
    },
    rotatorToQuat,
    quatToRotator,
    combineRotators,
    inverseRotator,
    deltaRotator,
    lerpRotator,
    rotatorForward,
    rotatorRight,
    rotatorUp,
    lookAtRotator,
    multiplyQuats,
    inverseQuat,
    slerpQuats,
    quatRotateVector,
    normalizeQuat,
    randomFloat: () => host.rng.nextFloat(),
    getAllActorsOfClass: (classId) => {
      const target = String(classId ?? "");
      const actors = services.getActors?.() ?? [];
      if (!target) return [];
      return actors.filter((actor) => {
        const id = actor.classId;
        if (!id) return false;
        return id === target || (services.classRegistry?.isA(id, target) ?? false);
      });
    },
    getActorOfClass: (classId) => {
      const target = String(classId ?? "");
      const actors = services.getActors?.() ?? [];
      if (!target) return null;
      return (
        actors.find((actor) => {
          const id = actor.classId;
          if (!id) return false;
          return id === target || (services.classRegistry?.isA(id, target) ?? false);
        }) ?? null
      );
    },
    attachActor: (child, parent) => {
      const actor = asActor(child);
      const target = asActor(parent);
      // Refuse before the bone detach so a rejected link changes nothing. A
      // destroyed parent is a stale reference and is refused the same way.
      // Attaching an actor to itself keeps its documented Detach behavior.
      if (target?.destroyed) return;
      if (actor && !actor.destroyed && target && target.guid !== actor.guid &&
        refuseParentCycle(services, actor, target, "Attach Actor")) return;
      if (actor && !actor.destroyed) services.attachToBone?.(actor, null, "");
      setActorLink(child, "parentId", parent);
    },
    detachActor: (child) => {
      const actor = asActor(child);
      if (actor && !actor.destroyed) services.attachToBone?.(actor, null, "");
      setActorLink(child, "parentId", null);
    },
    getParent: (actor) => readActorLink(services, actor, "parentId"),
    getActorName: (actor) => {
      const name = asActor(actor)?.getVariable("name");
      return typeof name === "string" ? name : "";
    },
    setOwner: (actor, owner) => {
      setActorLink(actor, "ownerId", owner);
    },
    getOwner: (actor) => readActorLink(services, actor, "ownerId"),
    executeConsoleCommand: (command) =>
      services.executeConsoleCommand(command),
    getFirstComponentOfType: (classId) =>
      componentsOfType(services, classId).next().value ?? null,
    getAllComponentsOfType: (classId) =>
      [...componentsOfType(services, classId)],
    getSceneLoadingProgress: () =>
      clamp01(services.getSceneLoadingProgress?.() ?? 1),
    getTargetSceneName: (target) => services.getTargetSceneName?.(target) ?? "",
    releaseAssetLoad: (handle) => services.releaseAssetLoad?.(handle),
    getAssetLoadHandleState: (handle) => services.getAssetLoadHandleState?.(handle) ?? "Failed",
    getAssetLoadHandleProgress: (handle) => clamp01(services.getAssetLoadHandleProgress?.(handle) ?? 0),
    getAssetLoadState: (assetGuid) => assetLoadStateName(services.getAssetLoadState?.(assetGuid)),
    loadSceneAsync: (target) => { void services.loadScene?.(target, false).catch((error) => services.reportError(error)); },
    unloadSceneAsync: (target) => { void services.unloadScene?.(target, false).catch((error) => services.reportError(error)); },
    isSceneLoaded: (target) => services.isSceneLoaded?.(target) ?? false,
    getSceneLoadProgress: (target) => clamp01(services.getSceneLoadProgress?.(target) ?? 0),
    getSceneState: (target) => services.getSceneState?.(target) ?? "Unloaded",
    getProjectName: () => services.getProjectName?.() ?? "",
    getProjectVersion: () => services.getProjectVersion?.() ?? "",
    getThirdPartyNotices: async () => {
      if (!services.getThirdPartyNotices) {
        return { success: false, text: "", errorMessage: "Third-party notices are not available here." };
      }
      try {
        return { success: true, text: await services.getThirdPartyNotices(), errorMessage: "" };
      } catch (error) {
        return { success: false, text: "", errorMessage: error instanceof Error ? error.message : String(error) };
      }
    },
    getSubsystem: (classId) => {
      const id = typeof classId === "string" ? classId.trim() : "";
      return id ? (services.getSubsystem?.(id) ?? null) : null;
    },
    getGameInstance: () => services.getGameInstance?.() ?? null,
    isA: (instance, classId) => {
      if (instance == null || typeof instance !== "object") return false;
      const id = (instance as { classId?: unknown }).classId;
      if (typeof id !== "string" || !id) return false;
      const target = String(classId ?? "");
      if (!target) return false;
      return services.classRegistry?.isA(id, target) ?? id === target;
    },
    getAnimGraphVariable: (target, name) =>
      animationGraphComponentOf(target)?.getVariable(String(name ?? "")),
    setAnimGraphVariable: (target, name, value) => {
      animationGraphComponentOf(target)?.setVariable(
        String(name ?? ""),
        value,
      );
    },
    getAnimGraphCurrentState: (target) =>
      services.animGraphControl?.(target)?.getCurrentState() ?? null,
    jumpAnimGraphState: (target, state) => {
      services.animGraphControl?.(target)?.jumpToState(String(state ?? ""));
    },
    setChannelVolume: (channelGuid, volume) => {
      services.setChannelVolume?.(
        String(channelGuid ?? ""),
        Number(volume ?? 1),
      );
    },
    setGlobalVolume: (volume) => {
      services.setGlobalVolume?.(Number(volume ?? 1));
    },
    changeScene: (scene) => {
      services.changeScene?.(scene);
    },
    createSceneLayer: (assetGuid, zOrder) =>
      services.createSceneLayer?.(String(assetGuid ?? ""), Number(zOrder) || 0) ??
      null,
    removeSceneLayer: (layer) => {
      const guid = sceneLayerGuidOf(layer);
      if (guid) services.removeSceneLayer?.(guid);
    },
    clearSceneLayers: () => {
      services.clearSceneLayers?.();
    },
    setFocusTarget: (target) => services.setFocusTarget?.(target) ?? false,
    clearFocusTarget: (target) => { services.clearFocusTarget?.(target); },
    registerSceneLayerPostProcess: (layer, materialGuid) => {
      const guid = sceneLayerGuidOf(layer);
      if (guid) {
        services.registerSceneLayerPostProcess?.(
          guid,
          String(materialGuid ?? ""),
        );
      }
    },
    unregisterSceneLayerPostProcess: (layer, materialGuid) => {
      const guid = sceneLayerGuidOf(layer);
      if (guid) {
        services.unregisterSceneLayerPostProcess?.(
          guid,
          String(materialGuid ?? ""),
        );
      }
    },
    setSceneLayerCameraLocation: (layer, location) => {
      setLayerCamera(layer, { x: vector2(location)?.x, y: vector2(location)?.y });
    },
    addSceneLayerCameraOffset: (layer, delta) => {
      const camera = layerCamera(layer);
      setLayerCamera(layer, { x: camera.x + Number(vector2(delta)?.x), y: camera.y + Number(vector2(delta)?.y) });
    },
    getSceneLayerCameraLocation: (layer) => {
      const camera = layerCamera(layer);
      return { x: camera.x, y: camera.y };
    },
    setSceneLayerCameraRotation: (layer, degrees) => { setLayerCamera(layer, { rotation: degrees }); },
    getSceneLayerCameraRotation: (layer) => layerCamera(layer).rotation,
    setSceneLayerCameraZoom: (layer, zoom) => { setLayerCamera(layer, { zoom }); },
    getSceneLayerCameraZoom: (layer) => layerCamera(layer).zoom,
    getOwningSceneLayer: (target) => services.getOwningSceneLayer?.(target instanceof EngineObject ? target : null) ?? null,
    getScalability: () => services.getScalability?.() ?? null,
    requestScalability: (request) => services.requestScalability?.(request) ?? {
      revision: 0, status: "unsupported", message: "Scalability requires an active Play or player session.",
    },
    possessCamera: (target) => {
      services.possessCamera?.(target);
    },
    getRenderTargetMode: (guid) => typeof guid === "string" ? services.getRenderTargetMode?.(guid) ?? "SceneColor" : "SceneColor",
    getRenderTargetTextureTarget: (guid) => typeof guid === "string" ? services.getRenderTargetTextureTarget?.(guid) ?? null : null,
    captureRenderTarget: (target) => {
      const component = captureComponent(target);
      if (component?.owner && host.canInvokeOwner(component)) services.captureRenderTarget?.(component.owner);
    },
    recaptureReflectionProbes: () => services.recaptureReflectionProbes?.(),
    getRenderTargetCaptureProperty: (target, key) => {
      const component = captureComponent(target);
      if (!component || !host.canInvokeOwner(component)) return createDefaultRenderTargetCaptureProperties()[key];
      return key === "actorIds" ? captureActorReferences(component, (id) => services.findActor?.(id)) : captureProperties(component)[key];
    },
    setRenderTargetCaptureProperty: (target, key, value) => {
      const component = captureComponent(target);
      if (component && host.canInvokeOwner(component) && setCaptureProperty(component, key, value, (id) => services.findActor?.(id))) {
        host.applyComponentVariable(component, key, value);
      }
    },
    getCameraFieldOfView: (target) =>
      Number(cameraComponentOf(target)?.getVariable("fieldOfView") ?? 60),
    setCameraFieldOfView: (target, fov) => {
      cameraComponentOf(target)?.setVariable("fieldOfView", Number(fov));
      services.updateIllumination?.(target);
    },
    getCameraOrthographicSize: (target) =>
      Number(
        cameraComponentOf(target)?.getVariable("orthographicSize") ?? 5,
      ),
    setCameraOrthographicSize: (target, size) => {
      cameraComponentOf(target)?.setVariable("orthographicSize", Number(size));
      services.updateIllumination?.(target);
    },
    setLightEnabled: (target, enabled) => {
      lightComponentOf(target)?.setVariable("enabled", Boolean(enabled));
      services.updateIllumination?.(target);
    },
    setLightColor: (target, color) => {
      lightComponentOf(target)?.setVariable("color", [
        Number(color?.x ?? 1),
        Number(color?.y ?? 1),
        Number(color?.z ?? 1),
      ]);
      services.updateIllumination?.(target);
    },
    setLightIntensity: (target, intensity) => {
      lightComponentOf(target)?.setVariable("intensity", Number(intensity));
      services.updateIllumination?.(target);
    },
    findPathTo: (from, to) => services.findPathTo?.(from, to) ?? [],
    isPathValid: (from, to) => services.isPathValid?.(from, to) ?? false,
    getClosestNavigablePoint: (point) =>
      services.getClosestNavigablePoint?.(point) ?? null,
    getRandomPointInRadius: (center, radius) =>
      services.getRandomPointInRadius?.(center, radius) ?? null,
    addObstacle: (kind, pose, size) =>
      services.addObstacle?.(kind, pose, size) ?? "",
    removeObstacle: (id) => {
      services.removeObstacle?.(id);
    },
  };
  return members;
}
