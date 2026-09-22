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
];
const field = (name: string, typeId: string, defaultValue?: unknown, typeClassId?: string): StructField =>
  ({ name, typeId, ...(defaultValue !== undefined ? { defaultValue } : {}), ...(typeClassId ? { typeClassId: `engine:${typeClassId}` } : {}) });
const number = (name: string, value: number) => field(name, "float", value);
const bool = (name: string, value: boolean) => field(name, "bool", value);
const choice = (name: string, type: string, value: string) => field(name, "enum", value, type);
const structure = (name: string, type: string) => field(name, "struct", undefined, type);
const define = (name: string, fields: StructField[]): EngineStruct => ({ id: `engine:${name}`, name: name.replace(/([a-z])([A-Z])/g, "$1 $2"), fields });
/** Stable built-in types use the same property keys as runtime readback. */
export const SCALABILITY_STRUCTS: EngineStruct[] = [
  define("ScalabilityResult", [number("revision", 0), choice("status", "ScalabilityStatus", "rebuildPending"), field("message", "string", "")]),
  define("ResolutionQuality", [number("scale", 1), bool("dynamic", true), number("minScale", 0.75), number("targetFps", 60)]),
  define("TextureQuality", [number("lodBias", 0), number("anisotropy", 4), number("byteBudget", 512 * 1024 ** 2)]),
  define("PostProcessingQuality", [number("resolutionScale", 0.75)]),
  define("LightingQuality", [choice("localLightMode", "LightBudgetMode", "auto"), number("maxLocalLights", 16)]),
  define("ShadowQuality", [bool("enabled", true), number("distance", 200), number("fadeFraction", 0.1), number("mapSize", 2048),
    number("cascades", 2), choice("filter", "ShadowFilter", "pcf"), choice("filterQuality", "ShadowFilterQuality", "medium"),
    number("softness", 0.05), bool("autoBias", true), number("depthBias", 0.0001), number("normalBias", 0.005),
    choice("localLightMode", "LightBudgetMode", "auto"), number("maxLocalLights", 2), number("localMapSize", 1024)]),
  define("CelShading", [number("shadowBands", 3), number("shadowThreshold", 0.5), number("shadowStrength", 0.65), bool("specularEnabled", true),
    number("specularStrength", 0.2), number("specularSize", 0.2), number("lightColorInfluence", 1), choice("lightMixing", "CelLightMixing", "strongest"),
    bool("outlinesEnabled", true), field("outlineColor", "color", { x: 0.03, y: 0.03, z: 0.03, w: 1 }), number("outlineWidth", 1)]),
  define("EnvironmentLighting", [bool("enabled", true), number("intensity", 1), number("rotationYDegrees", 0), number("celStrength", 0)]),
  define("BloomSettings", [bool("enabled", false), number("threshold", 0.9), number("weight", 0.15), number("kernel", 64), number("scale", 0.5)]),
  define("VignetteSettings", [bool("enabled", false), number("weight", 1.5)]),
  define("ColorPipelineSettings", [choice("mode", "ColorPipeline", "legacyDisplay")]),
  define("RenderEffects", [structure("colorPipeline", "ColorPipelineSettings"), choice("toneMapping", "ToneMapping", "none"), number("exposure", 1),
    number("contrast", 1), structure("vignette", "VignetteSettings"), structure("bloom", "BloomSettings"), bool("fxaa", false)]),
  define("RenderingQuality", [structure("resolution", "ResolutionQuality"), structure("textures", "TextureQuality"),
    structure("lighting", "LightingQuality"), structure("postprocessing", "PostProcessingQuality")]),
  define("RenderSettings", [choice("renderPath", "RenderPath", "forward"), choice("gpuBackend", "GpuBackend", "webgl2"), choice("mode", "RenderMode", "pbr"),
    structure("quality", "RenderingQuality"), structure("shadows", "ShadowQuality"), structure("cel", "CelShading"), structure("effects", "RenderEffects"),
    structure("environmentLighting", "EnvironmentLighting"), bool("customResolution", false), number("width", 1920), number("height", 1080), bool("blackBars", false)]),
  define("RuntimeRenderingSettings", [structure("render", "RenderSettings"), number("frameCap", 60)]),
  define("ScalabilitySnapshot", [structure("requested", "RuntimeRenderingSettings"), structure("effective", "RuntimeRenderingSettings"),
    structure("result", "ScalabilityResult"), number("appliedRevision", -1)]),
];
