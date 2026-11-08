import {
  assetLoadStateName,
  clampToRange,
  cloneSaveGameValue,
  combineRotators,
  curveTimeRange,
  createDefaultRenderTargetCaptureProperties,
  deltaRotator,
  curveKindForAssetType,
  evaluateCurve,
  evaluateCurveAnyOrder,
  floatCurveValueRange,
  formatValue,
  inverseQuat,
  inverseRotator,
  isInRange,
  lerpFloatRange,
  lerpRotator,
  lookAtRotator,
  mapFloatRange,
  multiplyQuats,
  normalizeQuat,
  quatRotateVector,
  quatToRotator,
  randomInRange,
  drawRandom,
  drawSeeded,
  normalizeRandomSeed,
  rotatorForward,
  rotatorRight,
  rotatorToQuat,
  rotatorUp,
  SaveGameError,
  slerpQuats,
  DEFAULT_GAME_ENVIRONMENT,
  localCalendarDate,
  parseEasingCurve,
  sampleEasingCurve,
  localTimeOfDay,
  newGuid,
  utcCalendarDate,
  utcTimeOfDay,
  type CurveAssetCatalogEntry,
  type CurveKind,
  type RandomStream,
  type SaveGameResult,
  type SaveGameValue,
} from "@haptic/core";
import { Actor, CurveObject, EngineObject, MaterialObject, PostProcessMaterialObject, Scene, SceneLayer, TimelineClipInstance, TimelineClipObject, TimelineObject } from "@haptic/object-model";
import { timelineClipState } from "./timeline-runtime";
import { createObjectMembers } from "./script-object-members";
import { createPhysicsMembers } from "./script-physics-members";
import { isInfiniteLoopError } from "@haptic/debugger";
import { EMPTY_ASSET_CATALOG } from "./asset-catalog";
import { captureActorReferences, captureComponent, captureProperties, setCaptureProperty } from "./render-targets";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { DispatcherBindings } from "./script-dispatchers";
import type { ComponentFunctionHost } from "./script-component-functions";
import type { HostContextMembers } from "./script-context-types";
import {
  animationGraphComponentOf,
  asActor,
  asActorComponent,
  cameraComponentOf,
  clamp01,
  componentsOfType,
  finiteVector,
  lightComponentOf,
  readActorLink,
  refuseParentCycle,
  requireSaveGameService,
  sceneLayerGuidOf,
  setActorLink,
} from "./script-host-helpers";
import type { ScriptMaterialOwnership } from "./script-material-ownership";
import { scriptValuesEqual } from "./script-values-equal";
import type { LatentFrameRoots } from "./latent-frame-roots";

/** Get Locale: the JavaScript environment's default locale, which browsers take from the user's language. */
function scriptLocale(): { locale: string; language: string } {
  let locale = "en-US";
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || locale;
  } catch {
    // Keep the fallback where Intl is unavailable.
  }
  return { locale, language: locale.split("-")[0]!.toLowerCase() };
}

/** Open URL's address: an absolute http or https URL, or null. */
function webAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** What `createHostMembers` reads from its `ScriptHost`. */
export interface HostMembersHost extends ComponentFunctionHost {
  /** The global seed: the normal Random nodes draw from it in call order. */
  readonly rng: RandomStream;
  readonly dispatchers: DispatcherBindings;
  /** Locals of waiting latent frames, which keep objects alive. */
  readonly frames: Pick<LatentFrameRoots, "hold">;
  readonly materials: ScriptMaterialOwnership;
  /** Read on each call because `setBreakpoints` replaces them after construction. */
  breakpoints(): ScriptBreakpoints | null;
}

/**
 * The members every context inherits: the ones whose behavior depends only on the host (see
 * `HostContextKey`). Built once per host. Their closures must not capture a per-call value, which
 * `createScriptContext` owns; they live in their own module so that a reference to one is a compile error.
 */
/** A handle structure's Id when it names one (a whole number from 1), else 0. */
function handleId(handle: unknown): number {
  const id = handle && typeof handle === "object" ? Number((handle as { Id?: unknown }).Id) : NaN;
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** A Sound Handle's voice id, `script:<Id>`; null for Id 0 or a value that is no handle. */
function soundVoiceId(handle: unknown): string | null {
  const id = handle && typeof handle === "object" ? Number((handle as { Id?: unknown }).Id) : NaN;
  return Number.isInteger(id) && id > 0 ? `script:${id}` : null;
}

/** A volume pin's value clamped to 0..1, or `fallback` when not a finite number. */
function unitVolume(value: unknown, fallback: number): number {
  const volume = Number(value);
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : fallback;
}

export function createHostMembers(host: HostMembersHost): HostContextMembers {
  const services = host.services;
  const curveObjects = new CurveObjectCache(() => services.curves);
  const unavailable = async <T>(): Promise<SaveGameResult<T>> => ({ ok: false, error: {
    code: "unavailable", message: "Select a default Save Game in Project Settings before using saves.",
  } });
  // Map fields are saved as `{ key, value }` entries and read as a Map; Actor values are saved as persistent IDs.
  const readField = (value: SaveGameValue, type?: string, container?: string): unknown => {
    if (container === "array" && Array.isArray(value)) return value.map((entry) => readField(entry, type));
    if (container === "map" && Array.isArray(value)) {
      return new Map(value.map((entry) => {
        const pair = entry as { key: SaveGameValue; value: SaveGameValue };
        return [pair.key, readField(pair.value, type)];
      }));
    }
    return type === "actor" && typeof value === "string" ? (services.resolveSaveActor?.(value) ?? services.findActor?.(value) ?? null) : value;
  };
  const writeField = (value: unknown, type?: string, container?: string): SaveGameValue => {
    if (container === "array" && Array.isArray(value)) return value.map((entry) => writeField(entry, type));
    if (container === "map" && value instanceof Map) {
      return [...value].map(([key, entry]) => ({ key: cloneSaveGameValue(key), value: writeField(entry, type) }));
    }
    return cloneSaveGameValue(type === "actor" && value instanceof Actor ? services.getSaveActorId?.(value) ?? value.guid : value);
  };
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
    getSaveField: (id, type, container) => readField(requireSaveGameService(services).getField(id), type, container),
    setSaveField: (id, value, type, container) => requireSaveGameService(services).setField(id, writeField(value, type, container)),
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
    eventDelegate: (object, name, kind, params) => host.dispatchers.delegate(object, name, kind, params),
    bindDispatcher: (owner, name, delegate) => host.dispatchers.bind(owner, name, delegate),
    unbindDispatcher: (owner, name, delegate) => host.dispatchers.unbind(owner, name, delegate),
    unbindAllDispatcher: (owner, name) => host.dispatchers.unbindAll(owner, name),
    holdFrame: (values) => host.frames.hold(values),
    createObject: (classId) => (typeof classId === "string" && classId ? services.createObject?.(classId) ?? null : null),
    collectGarbage: () => services.collectGarbage?.(),
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
    setGlobalFloatParameter: (collection, name, value) => {
      if (typeof value === "number" && Number.isFinite(value)) services.setGlobalParameter?.(collection, name, [value], ["float"]);
    },
    setGlobalVectorParameter: (collection, name, value) => {
      const xyz = value && typeof value === "object" ? [value.x, value.y, value.z] : [];
      if (xyz.length === 3 && xyz.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
        services.setGlobalParameter?.(collection, name, xyz, ["vec2", "vec3"]);
      }
    },
    setGlobalColorParameter: (collection, name, value) => {
      const rgba = value && typeof value === "object" ? [value.x, value.y, value.z, value.w] : [];
      if (rgba.length === 4 && rgba.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
        services.setGlobalParameter?.(collection, name, rgba, ["color"]);
      }
    },
    getGlobalFloatParameter: (collection, name) => {
      const result = services.getGlobalParameter?.(collection, name, ["float"]) ?? { found: false, value: [] };
      return { found: result.found, value: result.value[0] ?? 0 };
    },
    getGlobalVectorParameter: (collection, name) => {
      const result = services.getGlobalParameter?.(collection, name, ["vec2", "vec3"]) ?? { found: false, value: [] };
      const [x = 0, y = 0, z = 0] = result.value;
      return { found: result.found, value: { x, y, z } };
    },
    getGlobalColorParameter: (collection, name) => {
      const result = services.getGlobalParameter?.(collection, name, ["color"]) ?? { found: false, value: [] };
      const [x = 0, y = 0, z = 0, w = 1] = result.value;
      return { found: result.found, value: { x, y, z, w } };
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
    getMaterialVectorParameter: (material, name) => {
      const result = host.materials.getMaterialParameter(material, name, "vec3")
        ?? host.materials.getMaterialParameter(material, name, "vec2");
      const vector = result?.kind === "vec2" || result?.kind === "vec3";
      const [x = 0, y = 0, z = 0] = vector ? result.value : [];
      return { found: vector, value: { x, y, z } };
    },
    getMaterialTextureParameter: (material, name) => {
      const result = host.materials.getMaterialParameter(material, name, "texture");
      return { found: result?.kind === "texture", value: result?.kind === "texture" ? result.textureAssetGuid : null };
    },
    resetMaterialFloatParameter: (material, name) => host.materials.resetMaterialParameter(material, name, "float"),
    resetMaterialColorParameter: (material, name) => host.materials.resetMaterialParameter(material, name, "color"),
    resetMaterialVectorParameter: (material, name) =>
      host.materials.resetMaterialParameter(material, name, "vec3") ||
      host.materials.resetMaterialParameter(material, name, "vec2"),
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
    setMaterialVectorParameter: (material, name, value) => {
      if (!value || typeof value !== "object") return;
      const { x, y, z } = value;
      if (![x, y, z].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return;
      // The parameter's declared width decides what it takes: a Vector 2 keeps X and Y.
      const vec2 = !host.materials.getMaterialParameter(material, name, "vec3") &&
        host.materials.getMaterialParameter(material, name, "vec2") !== null;
      host.materials.setMaterialParameter(material, name, vec2 ? { kind: "vec2", value: [x, y] } : { kind: "vec3", value: [x, y, z] });
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
    randomInRange: (kind, range) => randomInRange(kind, range, host.rng),
    randomDraw: (draw, a, b) => drawRandom(host.rng, draw, a, b),
    seededRandomDraw: (reference, seed, draw, a, b) => {
      // Read through the reference, so a draw earlier in the same expression has already moved it on.
      const drawn = drawSeeded(reference?.get ? reference.get() : seed, draw, a, b);
      reference?.set(drawn.seed);
      return drawn.value;
    },
    getGlobalRandomSeed: () => host.rng.snapshot(),
    setGlobalRandomSeed: (seed) => {
      const next = normalizeRandomSeed(seed);
      host.rng.reset(next.Seed, next.Step);
    },
    randomSeedStep: (seed) => normalizeRandomSeed(seed).Step,
    clampToRange,
    isInRange,
    lerpFloatRange,
    mapFloatRange,
    evaluateCurve: (kind, curve, time) => evaluateCurveAnyOrder(kind, curve, Number(time)),
    getCurveObject: (kind, asset) => curveObjects.get(kind, asset),
    curveObjectValue: (kind, target, time) =>
      evaluateCurve(kind, curveObjectOf(target)?.curve ?? EMPTY_CURVE, Number(time)),
    curveObjectTimeRange: (target) => curveTimeRange(curveObjectOf(target)?.curve ?? EMPTY_CURVE),
    curveObjectValueRange: (target) => floatCurveValueRange(curveObjectOf(target)?.curve ?? EMPTY_CURVE),
    curveObjectKeyCount: (target) => curveObjectOf(target)?.curve.Keys.length ?? 0,
    timelineClipControl: (target, action, args) => {
      if (target instanceof TimelineClipObject && !target.destroyed && host.canInvokeOwner(target.owner)) {
        services.timelineClipControl?.(target, String(action), args ?? {});
      }
    },
    timelineClipState: (target, field) =>
      target instanceof TimelineClipObject ? timelineClipState(target, String(field)) : field === "playing" || field === "reversed" ? false : 0,
    getTimeline: (asset) => services.timeline?.(asset) ?? null,
    getTimelineClip: (target, documentGuid, clipId) => target instanceof TimelineObject && !target.destroyed
      ? services.timelineClips?.(target, { documentGuid: String(documentGuid), clipId: String(clipId) })[0] ?? null
      : null,
    getLoadedTimelineClips: (target) => target instanceof TimelineObject && !target.destroyed ? services.timelineClips?.(target) ?? [] : [],
    createTimelineClip: (target, assetGuid, inputs) => target instanceof TimelineObject && !target.destroyed
      ? services.createTimelineClip?.(target, String(assetGuid), inputs ?? {}) ?? null
      : null,
    timelineProxy: (target, action, proxyId, args) => {
      if (target instanceof TimelineClipInstance && !target.destroyed) services.timelineProxy?.(target, String(action), String(proxyId), args ?? {});
    },
    timelineProxyGet: (target, proxyId) => target instanceof TimelineClipInstance && !target.destroyed
      ? services.timelineProxyGet?.(target, String(proxyId)) ?? []
      : [],
    curveObjectCurve: (kind, target) => {
      const object = curveObjectOf(target);
      return structuredClone(object && object.kind === kind ? object.curve : EMPTY_CURVE);
    },
    curveTimeRange,
    floatCurveValueRange,
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
    getDeltaSeconds: () => services.getDeltaSeconds?.() ?? 0,
    getFrameCount: () => services.getFrameCount?.() ?? 0,
    getTimeNow: () => utcTimeOfDay(Date.now()),
    getDateNow: () => utcCalendarDate(Date.now()),
    getTimeMs: () => Date.now(),
    getTimeDilation: () => services.getTimeDilation?.() ?? 1,
    setTimeDilation: (rate) => {
      const value = Number(rate);
      if (Number.isFinite(value)) services.setTimeDilation?.(value);
    },
    getGameTimeSeconds: () => services.getGameTimeSeconds?.() ?? 0,
    getRealTimeSeconds: () => services.getRealTimeSeconds?.() ?? 0,
    getLocalTimeNow: () => localTimeOfDay(Date.now()),
    getLocalDateNow: () => localCalendarDate(Date.now()),
    setGamePaused: (paused) => services.setGamePaused?.(paused === true),
    isGamePaused: () => services.isGamePaused?.() ?? false,
    quitGame: () => services.quitGame?.(),
    getPlatform: () => (services.environment ?? DEFAULT_GAME_ENVIRONMENT).platform,
    isTouchDevice: () => (services.environment ?? DEFAULT_GAME_ENVIRONMENT).touchDevice,
    isInEditor: () => (services.environment ?? DEFAULT_GAME_ENVIRONMENT).inEditor,
    isDevelopmentBuild: () => (services.environment ?? DEFAULT_GAME_ENVIRONMENT).developmentBuild,
    getViewportSize: () => {
      const size = services.getViewportSize?.();
      return { x: size?.width ?? 0, y: size?.height ?? 0 };
    },
    getLocale: scriptLocale,
    copyToClipboard: (text) => services.copyToClipboard?.(typeof text === "string" ? text : String(text ?? "")),
    openUrl: (url) => {
      const address = webAddress(url);
      if (address) services.openUrl?.(address);
      else services.log("warning", "Script", `Open URL opens only http and https addresses, not "${String(url ?? "")}".`);
    },
    newGuid: () => newGuid(),
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
      // A destroyed object is no longer any class: Cast fails and returns None.
      if ((instance as { destroyed?: unknown }).destroyed === true) return false;
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
      const registered = guid ? services.registerSceneLayerPostProcess?.(guid, String(materialGuid ?? "")) : null;
      // The same Material Object Get Post Process Entry returns for the new pass.
      return registered ? services.getPostProcessEntry?.(registered.owner, registered.entryId) ?? null : null;
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
    registerScenePostProcess: (materialGuid) => {
      const registered = services.registerScenePostProcess?.(String(materialGuid ?? ""));
      return registered ? services.getPostProcessEntry?.(registered.owner, registered.entryId) ?? null : null;
    },
    unregisterScenePostProcess: (materialGuid) => {
      services.unregisterScenePostProcess?.(String(materialGuid ?? ""));
    },
    getOwningSceneLayer: (target) => services.getOwningSceneLayer?.(target instanceof EngineObject ? target : null) ?? null,
    getScalability: () => services.getScalability?.() ?? null,
    requestScalability: (request) => services.requestScalability?.(request) ?? {
      revision: 0, status: "unsupported", message: "Scalability requires an active Play or player session.",
    },
    possessCamera: (target) => {
      services.possessCamera?.(target);
    },
    possessCameraWithBlend: (target, seconds, curve) => {
      services.possessCamera?.(target, { seconds: Number(seconds), curve: typeof curve === "string" ? curve : "linear" });
    },
    getSceneCameraManager: () => services.getSceneCameraManager?.() ?? null,
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
    ...createObjectMembers(services),
    ...createPhysicsMembers(services),
    playCameraShake: (asset, scale) => ({ Id: services.cameraShakes?.play(asset, { scale: scale ?? 1 }) ?? 0 }),
    playCameraShakeOnSceneLayer: (layer, asset, scale) => {
      const guid = layer instanceof SceneLayer && !layer.destroyed ? layer.guid : null;
      return { Id: guid ? services.cameraShakes?.play(asset, { target: guid, scale: scale ?? 1 }) ?? 0 : 0 };
    },
    playWorldCameraShake: (asset, epicenter, innerRadius, outerRadius, falloff) => {
      const point = finiteVector(epicenter as never, 0);
      const inner = Number(innerRadius), outer = Number(outerRadius), exponent = Number(falloff);
      if (!point || ![inner, outer, exponent].every(Number.isFinite)) return { Id: 0 };
      return { Id: services.cameraShakes?.play(asset, { world: { epicenter: point, inner, outer, falloff: exponent } }) ?? 0 };
    },
    stopCameraShake: (handle, immediately) => {
      const id = handleId(handle);
      if (id) services.cameraShakes?.stop(id, immediately === true);
    },
    stopAllCameraShakes: (immediately) => services.cameraShakes?.stopAll(immediately === true),
    setCameraShakePaused: (handle, paused) => {
      const id = handleId(handle);
      if (id) services.cameraShakes?.setPaused(id, paused === true);
    },
    setCameraShakeScale: (handle, scale) => {
      const id = handleId(handle);
      if (id) services.cameraShakes?.setScale(id, scale);
    },
    isCameraShakePlaying: (handle) => {
      const id = handleId(handle);
      return id ? services.cameraShakes?.isPlaying(id) ?? false : false;
    },
    isCameraShakePaused: (handle) => {
      const id = handleId(handle);
      return id ? services.cameraShakes?.isPaused(id) ?? false : false;
    },
    stopSoundHandle: (handle) => {
      const voiceId = soundVoiceId(handle);
      if (voiceId && services.soundVoices?.isPlaying(voiceId)) services.stopSound?.(voiceId);
    },
    setSoundVolume: (handle, volume) => {
      const voiceId = soundVoiceId(handle);
      if (voiceId) services.soundVoices?.setVolume(voiceId, unitVolume(volume, 1));
    },
    setSoundPitch: (handle, pitch) => {
      const voiceId = soundVoiceId(handle);
      const value = Number(pitch);
      if (voiceId && Number.isFinite(value)) services.soundVoices?.setPitch(voiceId, value);
    },
    fadeInSound: (handle, seconds, volume) => {
      const voiceId = soundVoiceId(handle);
      if (voiceId) services.soundVoices?.fade(voiceId, Number(seconds), unitVolume(volume, 1), { from: 0 });
    },
    fadeOutSound: (handle, seconds) => {
      const voiceId = soundVoiceId(handle);
      if (voiceId) services.soundVoices?.fade(voiceId, Number(seconds), 0, { stopAtEnd: true });
    },
    isSoundPlaying: (handle) => {
      const voiceId = soundVoiceId(handle);
      return voiceId ? services.soundVoices?.isPlaying(voiceId) ?? false : false;
    },
    // The sampler clamps Alpha to 0..1 and reads a non-finite one as 0.
    easeAlpha: (curve, alpha) => sampleEasingCurve(parseEasingCurve(curve), Number(alpha)),
    clearTimer: (handle) => services.timers?.clear(timerId(handle)),
    setTimerPaused: (handle, paused) => services.timers?.setPaused(timerId(handle), paused === true),
    timerExists: (handle) => services.timers?.exists(timerId(handle)) ?? false,
    isTimerActive: (handle) => services.timers?.isActive(timerId(handle)) ?? false,
    isTimerPaused: (handle) => services.timers?.isPaused(timerId(handle)) ?? false,
    timerRemaining: (handle) => services.timers?.remaining(timerId(handle)) ?? -1,
    timerElapsed: (handle) => services.timers?.elapsed(timerId(handle)) ?? -1,
  };
  return members;
}

const EMPTY_CURVE = { Keys: [], Before: "constant", After: "constant" } as const;

function curveObjectOf(target: unknown): CurveObject | null {
  return target instanceof CurveObject ? target : null;
}

/**
 * One read-only Curve Object per curve asset for the host's session. Objects are never registered for
 * collection; a reloaded payload updates the existing object, so references stay valid.
 */
class CurveObjectCache {
  private readonly objects = new Map<string, { entry: CurveAssetCatalogEntry; object: CurveObject }>();
  private readonly catalog: () => ReadonlyMap<string, CurveAssetCatalogEntry> | undefined;

  constructor(catalog: () => ReadonlyMap<string, CurveAssetCatalogEntry> | undefined) {
    this.catalog = catalog;
  }

  get(kind: CurveKind, asset: unknown): CurveObject | null {
    const guid = typeof asset === "string" ? asset.trim() : "";
    const entry = guid ? this.catalog()?.get(guid) : undefined;
    if (!entry || curveKindForAssetType(entry.type) !== kind) return null;
    const cached = this.objects.get(guid);
    if (cached) {
      if (cached.entry !== entry) {
        cached.object.replaceCurve(entry.payload.curve);
        cached.entry = entry;
      }
      return cached.object;
    }
    const object = new CurveObject(kind, guid, entry.payload.curve);
    this.objects.set(guid, { entry, object });
    return object;
  }
}

/** A Timer Handle's id; anything else is 0, no timer. */
function timerId(handle: unknown): number {
  const id = Number((handle as { Id?: unknown } | null | undefined)?.Id);
  return Number.isInteger(id) && id > 0 ? id : 0;
}
