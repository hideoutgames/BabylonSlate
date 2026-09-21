import { normalizePlayFrameCap, normalizeRenderProjectSettings, type RenderProjectSettings } from "./project";
import { RenderingQualitySession, qualityPresetPatch, qualitySettingPatch, QUALITY_GROUPS, isQualityLevel, type QualityGroup, type QualityOverrides } from "./render-quality";
import type { ShadowOverrides } from "./shadows";
import type { ResolvedRenderingPipeline } from "./render-path";

export type RenderSettingsPatch<T = RenderProjectSettings> = {
  [K in keyof T]?: NonNullable<T[K]> extends readonly unknown[] ? T[K]
    : NonNullable<T[K]> extends object ? RenderSettingsPatch<NonNullable<T[K]>> : T[K];
};
export type ScalabilityStatus = "applied" | "clamped" | "unsupported" | "rebuildPending" | "restartRequired" | "failed";
export type RenderingApplicationPolicy = "live" | "rebuild" | "restart" | "authoring";
export interface RuntimeRenderingSettings { render: RenderProjectSettings; frameCap: number }
export interface ScalabilityResult { revision: number; status: ScalabilityStatus; message: string }
export interface ScalabilityTransaction {
  revision: number;
  settings: RuntimeRenderingSettings;
  /** Only explicit session fields override scene defaults. Never persisted. */
  overrides: RenderSettingsPatch;
}
export interface ScalabilityAcknowledgement extends ScalabilityResult {
  effective?: RuntimeRenderingSettings;
  pipeline?: ResolvedRenderingPipeline;
}
export interface ScalabilitySnapshot {
  requested: RuntimeRenderingSettings;
  /** Null until the renderer confirms its first ready frame. */
  effective: RuntimeRenderingSettings | null;
  pipeline: ResolvedRenderingPipeline | null;
  appliedRevision: number;
  result: ScalabilityResult;
}
export type ScalabilityRequest =
  | { kind: "preset"; preset: "low" | "medium" | "high" | "ultra"; group?: QualityGroup }
  | { kind: "patch"; render?: RenderSettingsPatch; frameCap?: number }
  | { kind: "reset"; group?: QualityGroup };

const ENUMS: Record<string, readonly unknown[]> = {
  gpuBackend: ["auto", "webgl2", "webgpu"], renderPath: ["auto", "forward", "clusteredForward"],
  mode: ["pbr", "cel"], "cel.lightMixing": ["strongest", "additive", "blend"],
  "shadows.filter": ["pcf", "pcss"], "shadows.filterQuality": ["low", "medium", "high"],
  "shadows.localLightMode": ["auto", "manual"], "quality.lighting.localLightMode": ["auto", "manual"],
  "effects.colorPipeline.mode": ["legacyDisplay", "sceneLinear"],
  "effects.toneMapping": ["none", "standard", "aces", "neutral"],
};
const LIVE_FIELDS = new Set([
  "frameCap", "cel.shadowBands", "cel.shadowThreshold", "cel.shadowStrength", "cel.specularStrength",
  "cel.specularSize", "cel.lightColorInfluence", "shadows.distance", "shadows.fadeFraction",
  "shadows.softness", "shadows.autoBias", "shadows.depthBias", "shadows.normalBias",
  "quality.textures.anisotropy", "quality.textures.byteBudget", "quality.resolution.targetFps",
  "environmentLighting.enabled", "environmentLighting.intensity", "environmentLighting.rotationYDegrees",
  "environmentLighting.celStrength",
]);
/** Conservative application policy: shader/resource changes wait at the view boundary. */
export function renderingApplicationPolicy(path: string): RenderingApplicationPolicy {
  if (path === "gpuBackend") return "restart";
  if (path === "effects.colorPipeline.version" || /\.(profile|preset)$/.test(path)) return "authoring";
  return LIVE_FIELDS.has(path) ? "live" : "rebuild";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}
/** Used only with validated known fields; arrays are values, never property bags. */
export function mergeRenderSettings<T>(base: T, patch: RenderSettingsPatch<T>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = record(value) && record(result[key]) ? mergeRenderSettings(result[key], value) : structuredClone(value);
  }
  return result as T;
}
function validatePatch(patch: unknown, template: unknown, prefix = ""): string | undefined {
  if (!record(patch) || !record(template)) return `${prefix || "render"} must be a settings object.`;
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(template, key)) return `Unknown rendering setting: ${path}.`;
    if (renderingApplicationPolicy(path) === "authoring") return `${path} is authoring-only; use Set Scalability Preset for quality tiers.`;
    const expected = template[key];
    if (record(expected)) {
      const error = validatePatch(value, expected, path);
      if (error) return error;
    } else if (ENUMS[path]) {
      if (!ENUMS[path].includes(value)) return `Unsupported value for ${path}.`;
    } else if (Array.isArray(expected)) {
      if (!Array.isArray(value) || value.length !== expected.length || !value.every((n) => typeof n === "number" && Number.isFinite(n)))
        return `${path} requires ${expected.length} finite numbers.`;
    } else if (typeof value !== typeof expected || (typeof value === "number" && !Number.isFinite(value))) {
      return `${path} requires a finite ${typeof expected}.`;
    }
  }
}
/** Retain just the requested fields after normalization, so inheritance stays live. */
function selectedFields(patch: Record<string, unknown>, normalized: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key,
    record(value) && record(normalized[key]) ? selectedFields(value, normalized[key]) : normalized[key]]));
}

/** One session owner for graphs, game settings UI and console commands. No engine objects. */
export class ScalabilitySession {
  private readonly project: RuntimeRenderingSettings;
  private readonly quality: RenderingQualitySession;
  private visualOverrides: RenderSettingsPatch = {};
  private frameCapOverride: number | undefined;
  private revision = 0;
  private appliedRevision = -1;
  private effective: RuntimeRenderingSettings | null = null;
  private pipeline: ResolvedRenderingPipeline | null = null;
  private result: ScalabilityResult = { revision: 0, status: "rebuildPending", message: "Waiting for the renderer's first ready frame." };
  constructor(
    project: Partial<RenderProjectSettings> | undefined,
    frameCap: number | undefined,
    scene: ShadowOverrides = {},
    private readonly submit: (transaction: ScalabilityTransaction) => void = () => {},
  ) {
    this.project = { render: normalizeRenderProjectSettings(project), frameCap: normalizePlayFrameCap(frameCap) };
    this.quality = new RenderingQualitySession(this.project.render, scene);
  }
  get overrides(): RenderSettingsPatch {
    const { shadows, ...quality } = this.quality.overrides;
    return { ...structuredClone(this.visualOverrides), ...(shadows ? { shadows: structuredClone(shadows) } : {}),
      ...(Object.keys(quality).length ? { quality: structuredClone(quality) } : {}) };
  }
  get requested(): RuntimeRenderingSettings {
    const { shadows, ...quality } = this.quality.effective();
    return { render: { ...mergeRenderSettings(this.project.render, this.visualOverrides), shadows, quality },
      frameCap: this.frameCapOverride ?? this.project.frameCap };
  }
  snapshot(): ScalabilitySnapshot {
    return structuredClone({ requested: this.requested, effective: this.effective, pipeline: this.pipeline,
      appliedRevision: this.appliedRevision, result: this.result });
  }
  transaction(): ScalabilityTransaction {
    return { revision: this.revision, settings: this.requested, overrides: this.overrides };
  }
  /** Scene inheritance changes; session overrides keep their declared scope. */
  setScene(shadows: ShadowOverrides): void {
    const before = this.requested;
    this.quality.scene = shadows;
    this.publish(before, "Scene rendering defaults changed.");
  }
  request(request: ScalabilityRequest): ScalabilityResult {
    const before = this.requested;
    const previousOverrides = this.overrides;
    if (request.kind === "preset") {
      if (!isQualityLevel(request.preset) || (request.group !== undefined && !QUALITY_GROUPS.includes(request.group)))
        return this.rejected("unsupported", "Unknown quality preset or group.");
      this.quality.overrides = { ...this.quality.overrides, ...qualityPresetPatch(request.preset, request.group) };
    } else if (request.kind === "reset") {
      if (request.group !== undefined && !QUALITY_GROUPS.includes(request.group)) return this.rejected("unsupported", "Unknown quality group.");
      if (request.group) {
        this.quality.overrides = { ...this.quality.overrides };
        delete this.quality.overrides[request.group];
      } else {
        this.visualOverrides = {};
        this.quality.overrides = {};
        this.frameCapOverride = undefined;
      }
    } else if (request.kind === "patch") {
      const error = validatePatch(request.render ?? {}, before.render);
      if (error) return this.rejected("failed", error);
      if (request.frameCap !== undefined && (!Number.isFinite(request.frameCap) || request.frameCap <= 0))
        return this.rejected("failed", "Frame cap must be a finite number greater than zero.");
      if (request.render?.gpuBackend !== undefined && request.render.gpuBackend !== before.render.gpuBackend)
        return this.rejected("restartRequired", "GPU backend changes require restarting the player; this transaction was not applied.");
      const patch = request.render ?? {};
      const normalized = normalizeRenderProjectSettings(mergeRenderSettings(before.render, patch));
      const selected = selectedFields(patch as Record<string, unknown>, normalized as unknown as Record<string, unknown>) as RenderSettingsPatch;
      const { quality, shadows, ...visual } = selected;
      this.visualOverrides = mergeRenderSettings(this.visualOverrides, visual);
      const qualityPatch: QualityOverrides = { ...quality, ...(shadows ? { shadows } : {}) };
      for (const group of QUALITY_GROUPS) if (qualityPatch[group])
        Object.assign(this.quality.overrides, qualitySettingPatch(group, { ...this.quality.overrides[group], ...qualityPatch[group] }));
      if (request.frameCap !== undefined) this.frameCapOverride = request.frameCap;
      const clamped = !same(selected, patch);
      return this.publish(before, clamped ? "Values were clamped; waiting for the renderer." : "Waiting for the renderer.", previousOverrides, clamped);
    } else return this.rejected("unsupported", "Unknown scalability request.");
    return this.publish(before, "Waiting for the renderer.", previousOverrides);
  }
  /** Console parsing stays here; graph nodes call request() directly. */
  executeQuality(group?: QualityGroup, choice?: string, value?: string): { success: boolean; output: string } {
    const before = this.requested;
    const previous = this.overrides;
    const response = this.quality.execute(group, choice, value);
    if (response.success) this.publish(before, "Waiting for the renderer.", previous);
    return response;
  }
  /** Ignore stale asynchronous completions and duplicates; only ready frames advance effective values. */
  acknowledge(ack: ScalabilityAcknowledgement): boolean {
    if (ack.revision !== this.revision || same(this.result, { revision: ack.revision, status: ack.status, message: ack.message }) && same(this.effective, ack.effective ?? this.effective)) return false;
    if (ack.effective && (ack.status === "applied" || ack.status === "clamped")) {
      this.effective = structuredClone(ack.effective);
      this.appliedRevision = ack.revision;
    }
    if (ack.pipeline) this.pipeline = structuredClone(ack.pipeline);
    this.result = { revision: ack.revision, status: ack.status, message: ack.message };
    return true;
  }
  private rejected(status: ScalabilityStatus, message: string): ScalabilityResult {
    return { revision: this.revision, status, message };
  }
  private publish(before: RuntimeRenderingSettings, message: string, previousOverrides = this.overrides, clamped = false): ScalabilityResult {
    if (same(before, this.requested) && same(previousOverrides, this.overrides))
      return clamped ? { ...this.result, status: "clamped", message: "Values were clamped to the existing request." } : { ...this.result };
    this.result = { revision: ++this.revision, status: "rebuildPending", message };
    this.submit(this.transaction());
    return { ...this.result };
  }
}
