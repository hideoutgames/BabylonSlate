import { pin, enumRef, structRef, BOOL, FLOAT, INT, COLOR, STRING, EXEC, type NodeDefinition, type GraphPin, type CodegenContext } from "@babylonslate/scripting";

const result = () => pin("result", "Result", "out", structRef("engine:ScalabilityResult"));
const exec = () => [pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC)];
const input = (name: string, label: string, type: GraphPin["type"], defaultValue?: unknown): GraphPin =>
  ({ ...pin(name, label, "in", type), ...(defaultValue !== undefined ? { defaultValue } : {}) });
function setter(id: string, title: string, description: string, inputs: GraphPin[], request: (ctx: CodegenContext) => string): NodeDefinition {
  return { id: `scalability.${id}`, title, description, category: "scalability", pins: () => [...exec(), ...inputs, result()],
    codegen: (ctx) => ctx.emit(`${ctx.output("result")} = ctx.requestScalability(${request(ctx)});`) };
}
function setting(id: string, title: string, description: string, type: string, path: string[]): NodeDefinition {
  return setter(id, title, description, [input("settings", "Settings", structRef(`engine:${type}`))], (ctx) => {
    const body = path.reduceRight((value, key) => `{ ${key}: ${value} }`, ctx.input("settings"));
    return `{ kind: "patch", render: ${body} }`;
  });
}
export const scalabilityNodes: NodeDefinition[] = [
  { id: "scalability.getEffective", title: "Get Effective Scalability", category: "scalability", pure: true,
    description: "Read requested and last renderer-confirmed settings. Ready is false before the first ready frame; pending or failed requests retain the previous effective values.",
    pins: () => [pin("settings", "Settings", "out", structRef("engine:ScalabilitySnapshot")), pin("ready", "Ready", "out", BOOL),
      pin("requestedBackend", "Requested GPU Backend", "out", enumRef("engine:GpuBackend")), pin("effectiveBackend", "Effective GPU Backend", "out", enumRef("engine:GpuBackend")),
      pin("fallbackReason", "Fallback Reason", "out", STRING), pin("vignetteColor", "Vignette Color", "out", COLOR)],
    codegen: () => ({ settings: "ctx.getScalability()", ready: "(ctx.getScalability()?.effective != null)",
      requestedBackend: "(ctx.getScalability()?.pipeline?.requested.gpuBackend ?? ctx.getScalability()?.requested.render.gpuBackend ?? 'auto')",
      effectiveBackend: "(ctx.getScalability()?.pipeline?.effective.gpuBackend ?? 'auto')",
      fallbackReason: "(ctx.getScalability()?.pipeline?.limits.join(' ' ) ?? '')",
      vignetteColor: "((c) => ({ x: c?.[0] ?? 0, y: c?.[1] ?? 0, z: c?.[2] ?? 0, w: 1 }))(ctx.getScalability()?.effective?.render.effects?.vignette.color)" }) },
  setter("setPreset", "Set Scalability Preset", "Apply a session quality tier. CEL/PBR, outline appearance and artistic effects remain independently authored.",
    [input("preset", "Preset", enumRef("engine:ScalabilityPreset"), "medium")], (ctx) => `{ kind: "preset", preset: ${ctx.input("preset")} }`),
  setter("setRenderScale", "Set Render Scale", "Set fixed render scale (0.25–1). Disables dynamic resolution. Wait for the settings-changed event for effective values.",
    [input("scale", "Scale", FLOAT, 1)], (ctx) => `{ kind: "patch", render: { quality: { resolution: { scale: ${ctx.input("scale")}, minScale: ${ctx.input("scale")}, dynamic: false } } } }`),
  setter("setResolution", "Set Render Resolution", "Lock the output dimensions with letterboxing. Reset to Project Defaults restores the authored output policy.",
    [input("width", "Width", INT, 1920), input("height", "Height", INT, 1080)], (ctx) => `{ kind: "patch", render: { width: ${ctx.input("width")}, height: ${ctx.input("height")}, customResolution: true, blackBars: true } }`),
  setter("setFrameCap", "Set Frame Cap", "Cap presentation frames per second. The fixed simulation step is unchanged.",
    [input("fps", "Frames Per Second", FLOAT, 60)], (ctx) => `{ kind: "patch", frameCap: ${ctx.input("fps")} }`),
  setter("setShadowsEnabled", "Set Shadows Enabled", "Enable or disable shadows for this session while retaining shadow settings.",
    [input("enabled", "Enabled", BOOL, true)], (ctx) => `{ kind: "patch", render: { shadows: { enabled: ${ctx.input("enabled")} } } }`),
  setter("setAntialiasing", "Set Antialiasing", "Enable the production FXAA pass. The view prepares its replacement graph before acknowledging the request.",
    [input("enabled", "FXAA Enabled", BOOL, true)], (ctx) => `{ kind: "patch", render: { effects: { fxaa: ${ctx.input("enabled")} } } }`),
  setter("setVignetteColor", "Set Vignette Color", "Set the display-space vignette tint without changing its enablement or weight.",
    [input("color", "Color", COLOR, { x: 0, y: 0, z: 0, w: 1 })], (ctx) => `{ kind: "patch", render: { effects: { vignette: { color: [${ctx.input("color")}.x, ${ctx.input("color")}.y, ${ctx.input("color")}.z] } } } }`),
  setter("setRenderMode", "Set Render Mode", "Switch PBR/CEL for this session through the shared material owner. The result remains pending until ready.",
    [input("mode", "Mode", enumRef("engine:RenderMode"), "pbr")], (ctx) => `{ kind: "patch", render: { mode: ${ctx.input("mode")} } }`),
  setter("setRenderPath", "Set Render Path", "Request the global render path. Effective readback reports backend or scene restrictions.",
    [input("path", "Render Path", enumRef("engine:RenderPath"), "forward")], (ctx) => `{ kind: "patch", render: { renderPath: ${ctx.input("path")} } }`),
  setting("setResolutionQuality", "Set Resolution Quality", "Configure render scale, dynamic resolution bounds and target frame rate for this session.", "ResolutionQuality", ["quality", "resolution"]),
  setting("setShadowQuality", "Set Shadow Quality", "Configure shadow maps, filtering, distance and local admission. Resource changes prepare at a frame boundary.", "ShadowQuality", ["shadows"]),
  setting("setLightingQuality", "Set Lighting Quality", "Choose automatic or explicit local-light admission within the current quality tier.", "LightingQuality", ["quality", "lighting"]),
  setting("setTextureQuality", "Set Texture Quality", "Set texture LOD bias, anisotropy and the managed byte budget. Device anisotropy limits appear in effective readback.", "TextureQuality", ["quality", "textures"]),
  setting("setPostProcessingQuality", "Set Post Processing Quality", "Scale passes that opt into scalable resolution. Artistic effect enablement remains independent.", "PostProcessingQuality", ["quality", "postprocessing"]),
  setting("setEffects", "Set Rendering Effects", "Configure the supported color pipeline, tone mapping, exposure, bloom, vignette and FXAA for this session.", "RenderEffects", ["effects"]),
  setting("setCelShading", "Set CEL Shading", "Change CEL banding, specular and light mixing without changing project defaults.", "CelShading", ["cel"]),
  setting("setEnvironmentLighting", "Set Environment Lighting", "Change IBL enablement, intensity, orientation and CEL strength. Environment assets remain authored scene data.", "EnvironmentLighting", ["environmentLighting"]),
  setter("reset", "Reset to Project Defaults", "Clear temporary session overrides. Scene defaults resume inheritance. Persistent player preferences are separate.", [], () => `{ kind: "reset" }`),
  { id: "flow.event.scalabilityChanged", title: "Event Scalability Changed", category: "scalability", pure: true,
    description: "Runs when the renderer confirms or rejects the latest request. Read the result and effective settings; stale completions are ignored.",
    pins: () => [pin("execOut", "Then", "out", EXEC), pin("settings", "Settings", "out", structRef("engine:ScalabilitySnapshot"))],
    codegen: () => ({ settings: "ctx.args.settings" }) },
];
