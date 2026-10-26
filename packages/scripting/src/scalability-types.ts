import { DEFAULT_SHADOW_SETTINGS, RENDER_QUALITY_PROFILES } from "@haptic/core";
import type { EngineEnum, EngineStruct } from "./engine-types";
import type { StructField } from "./type-assets";

const enumeration = (name: string, members: string[]): EngineEnum => ({
  id: `engine:${name}`, name: name.replace(/([a-z])([A-Z])/g, "$1 $2"), members: members.map((name, value) => ({ name, value })),
});
export const SCALABILITY_ENUMS: EngineEnum[] = [
  enumeration("ScalabilityPreset", ["low", "medium", "high", "ultra"]),
  enumeration("ScalabilityStatus", ["applied", "clamped", "unsupported", "rebuildPending", "restartRequired", "failed"]),
  enumeration("RenderPath", ["auto", "forward", "clusteredForward"]),
  enumeration("GpuBackend", ["auto", "webgl2", "webgpu"]),
  enumeration("RenderMode", ["pbr", "cel"]),
  enumeration("LightBudgetMode", ["auto", "manual"]),
  enumeration("ShadowFilter", ["pcf", "pcss"]),
  enumeration("ShadowFilterQuality", ["low", "medium", "high"]),
  enumeration("CelLightMixing", ["strongest", "additive", "blend"]),
  enumeration("ToneMapping", ["none", "standard", "aces", "neutral"]),
  enumeration("ColorPipeline", ["legacyDisplay", "sceneLinear"]),
  enumeration("WaterShadingDetail", ["low", "medium", "high", "ultra"]),
  enumeration("WaterReflectionMode", ["sky", "screenSpace", "planar"]),
];
const field = (name: string, typeId: string, defaultValue?: unknown, typeClassId?: string): StructField =>
  ({ name, typeId, ...(defaultValue !== undefined ? { defaultValue } : {}), ...(typeClassId ? { typeClassId: `engine:${typeClassId}` } : {}) });
const number = (name: string, value: number) => field(name, "float", value);
const bool = (name: string, value: boolean) => field(name, "bool", value);
const choice = (name: string, type: string, value: string) => field(name, "enum", value, type);
const structure = (name: string, type: string) => field(name, "struct", undefined, type);
const define = (name: string, fields: StructField[]): EngineStruct => ({ id: `engine:${name}`, name: name.replace(/([a-z])([A-Z])/g, "$1 $2"), fields });
/** Quality structs default to the Medium tier. */
const medium = RENDER_QUALITY_PROFILES.medium, shadows = DEFAULT_SHADOW_SETTINGS;
/** Stable built-in types use the same property keys as runtime readback. */
export const SCALABILITY_STRUCTS: EngineStruct[] = [
  define("ScalabilityResult", [number("revision", 0), choice("status", "ScalabilityStatus", "rebuildPending"), field("message", "string", "")]),
  define("ResolutionQuality", [number("scale", medium.resolution.scale), bool("dynamic", medium.resolution.dynamic),
    number("minScale", medium.resolution.minScale), number("targetFps", medium.resolution.targetFps)]),
  define("TextureQuality", [number("lodBias", medium.textures.lodBias), number("anisotropy", medium.textures.anisotropy),
    number("byteBudget", medium.textures.byteBudget)]),
  define("GeometryQuality", [bool("autoLod", medium.geometry.autoLod), number("lodDistanceScale", medium.geometry.lodDistanceScale)]),
  // Defaults equal the Medium tier; normalization rounds integer fields and snaps FFT Size.
  define("WaterQuality", [choice("shadingDetail", "WaterShadingDetail", medium.water.shadingDetail), number("meshDensity", medium.water.meshDensity),
    number("contactResolution", medium.water.contactResolution), bool("refraction", medium.water.refraction),
    number("refractionScale", medium.water.refractionScale), choice("reflections", "WaterReflectionMode", medium.water.reflections),
    number("reflectionSteps", medium.water.reflectionSteps), number("planarScale", medium.water.planarScale),
    number("fftSize", medium.water.fftSize), number("fftCascades", medium.water.fftCascades)]),
  define("PostProcessingQuality", [number("resolutionScale", medium.postprocessing.resolutionScale)]),
  define("LightingQuality", [choice("localLightMode", "LightBudgetMode", medium.lighting.localLightMode), number("maxLocalLights", medium.lighting.maxLocalLights)]),
  define("ShadowQuality", [bool("enabled", shadows.enabled), number("distance", shadows.distance), number("fadeFraction", shadows.fadeFraction),
    number("mapSize", shadows.mapSize), number("cascades", shadows.cascades), choice("filter", "ShadowFilter", shadows.filter),
    choice("filterQuality", "ShadowFilterQuality", shadows.filterQuality), number("softness", shadows.softness), bool("autoBias", shadows.autoBias),
    number("depthBias", shadows.depthBias), number("normalBias", shadows.normalBias), choice("localLightMode", "LightBudgetMode", shadows.localLightMode),
    number("maxLocalLights", shadows.maxLocalLights), number("localMapSize", shadows.localMapSize)]),
  define("CelShading", [number("shadowBands", 3), number("shadowThreshold", 0.5), number("shadowStrength", 0.65), bool("specularEnabled", true),
    number("specularStrength", 0.2), number("specularSize", 0.2), number("lightColorInfluence", 1), choice("lightMixing", "CelLightMixing", "strongest"),
    bool("outlinesEnabled", true), field("outlineColor", "color", { x: 0.03, y: 0.03, z: 0.03, w: 1 }), number("outlineWidth", 1),
    bool("outlineDistanceFadeEnabled", false), number("outlineFadeStart", 50), number("outlineFadeEnd", 100)]),
  define("EnvironmentLighting", [bool("enabled", true), number("intensity", 1), number("rotationYDegrees", 0), number("celStrength", 0)]),
  define("BloomSettings", [bool("enabled", false), number("threshold", 0.9), number("weight", 0.15), number("kernel", 64), number("scale", 0.5)]),
  define("VignetteSettings", [bool("enabled", false), number("weight", 1.5)]),
  define("ColorPipelineSettings", [choice("mode", "ColorPipeline", "legacyDisplay")]),
  define("RenderEffects", [structure("colorPipeline", "ColorPipelineSettings"), choice("toneMapping", "ToneMapping", "none"), number("exposure", 1),
    number("contrast", 1), structure("vignette", "VignetteSettings"), structure("bloom", "BloomSettings"), bool("fxaa", false)]),
  define("RenderingQuality", [structure("resolution", "ResolutionQuality"), structure("textures", "TextureQuality"),
    structure("geometry", "GeometryQuality"), structure("water", "WaterQuality"), structure("lighting", "LightingQuality"),
    structure("postprocessing", "PostProcessingQuality")]),
  define("RenderSettings", [choice("renderPath", "RenderPath", "forward"), choice("gpuBackend", "GpuBackend", "webgl2"), choice("mode", "RenderMode", "pbr"),
    structure("quality", "RenderingQuality"), structure("shadows", "ShadowQuality"), structure("cel", "CelShading"), structure("effects", "RenderEffects"),
    structure("environmentLighting", "EnvironmentLighting"), bool("customResolution", false), number("width", 1920), number("height", 1080), bool("blackBars", false)]),
  define("RuntimeRenderingSettings", [structure("render", "RenderSettings"), number("frameCap", 60)]),
  define("ScalabilitySnapshot", [structure("requested", "RuntimeRenderingSettings"), structure("effective", "RuntimeRenderingSettings"),
    structure("result", "ScalabilityResult"), number("appliedRevision", -1)]),
];
