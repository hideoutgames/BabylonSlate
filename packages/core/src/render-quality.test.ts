import { describe, expect, it } from "vitest";
import {
  QUALITY_GROUPS,
  QUALITY_LEVELS,
  qualityGroupLabel,
  RenderingQualitySession,
  resolveRenderingQuality,
  qualityPresetPatch,
  qualitySettingPatch,
  applyProjectQualityPatch,
  resolveLocalLightBudget,
  normalizeRenderingQuality,
  RENDER_QUALITY_PROFILES,
} from "./render-quality";
import {
  DEFAULT_RENDER_PROJECT_SETTINGS,
  normalizeProjectSettings,
} from "./project";

describe("rendering quality sessions", () => {
  it("replaces the complete shadow category including a saved Manual budget when applying presets", () => {
    const session = new RenderingQualitySession({
      shadows: { distance: 600, maxLocalLights: 9 },
    });
    session.execute(undefined, "low");
    expect(session.effective().shadows).toMatchObject({
      distance: 80,
      maxLocalLights: 1,
      localLightMode: "auto",
      mapSize: 1024,
    });
    session.execute("shadows", "budget", "12");
    session.execute("shadows", "ultra");
    expect(session.effective().shadows).toMatchObject({
      distance: 600,
      maxLocalLights: 8,
      localLightMode: "auto",
      mapSize: 4096,
    });
  });
  it("preserves session overrides across scenes and resets independently to current inherited values", () => {
    const session = new RenderingQualitySession(
      { shadows: { distance: 200 } },
      { distance: 80 },
    );
    session.execute("shadows", "distance", "350");
    session.execute("resolution", "scale", "0.5");
    session.scene = { distance: 120 };
    expect(session.effective().shadows.distance).toBe(350);
    session.execute("shadows", "reset");
    expect(session.effective().shadows.distance).toBe(120);
    expect(session.effective().resolution.scale).toBe(0.5);
    session.execute(undefined, "reset");
    expect(session.effective().resolution.scale).toBe(1);
  });
  it("reports each chosen tier even when two tiers share a setting value", () => {
    const session = new RenderingQualitySession();
    for (const level of QUALITY_LEVELS) {
      session.execute(undefined, level);
      for (const group of QUALITY_GROUPS)
        expect(qualityGroupLabel(session.effective(), group)).toBe(level);
    }
  });
  it("does not mutate overrides already dispatched to the renderer", () => {
    const session = new RenderingQualitySession();
    session.execute("shadows", "budget", "8");
    const dispatched = session.overrides;
    session.execute("shadows", "reset");
    expect(dispatched.shadows?.maxLocalLights).toBe(8);
    expect(session.execute(undefined, "low", "unexpected").success).toBe(false);
  });
  it("rejects invalid settings without changing the effective configuration", () => {
    const session = new RenderingQualitySession();
    for (const value of ["-1", "3.5", "Infinity", "NaN"])
      expect(session.execute("shadows", "budget", value).success).toBe(false);
    expect(session.effective()).toEqual(resolveRenderingQuality());
  });
  it("queries actual custom values instead of a hardcoded profile", () => {
    const session = new RenderingQualitySession({
      shadows: { distance: 321, mapSize: 512 },
    });
    expect(session.execute("shadows").output).toContain('"distance":321');
    expect(session.execute("shadows").output).toContain("custom");
  });
  it("preserves the Manual number only when toggling mode, and resets it on a tier selection", () => {
    const session = new RenderingQualitySession();
    session.execute("shadows", "budget", "16");
    session.execute("shadows", "budget", "auto");
    expect(session.effective().shadows).toMatchObject({
      localLightMode: "auto",
      maxLocalLights: 16,
      profile: "medium",
      preset: "custom",
    });
    session.execute("shadows", "low");
    expect(session.effective().shadows).toMatchObject({
      localLightMode: "auto",
      maxLocalLights: 1,
      profile: "low",
      preset: "low",
    });
    session.execute("shadows", "reset");
    expect(session.effective().shadows.localLightMode).toBe("auto");
  });
  it("preserves Custom provenance through save/load even when a manual value matches another preset", () => {
    let render = applyProjectQualityPatch(
      DEFAULT_RENDER_PROJECT_SETTINGS,
      qualityPresetPatch("high"),
    );
    render = applyProjectQualityPatch(
      render,
      qualitySettingPatch("textures", {
        anisotropy: 16,
        byteBudget: 2048 * 1024 ** 2,
      }),
    );
    const saved = normalizeProjectSettings(
      JSON.parse(JSON.stringify({ render })),
    ).render;
    expect(qualityGroupLabel(resolveRenderingQuality(saved), "textures")).toBe(
      "custom",
    );
    expect(saved.quality?.textures.profile).toBe("high");
    const reapplied = applyProjectQualityPatch(
      saved,
      qualityPresetPatch("ultra", "textures"),
    );
    expect(
      qualityGroupLabel(resolveRenderingQuality(reapplied), "textures"),
    ).toBe("ultra");
    expect(
      qualityGroupLabel(resolveRenderingQuality(reapplied), "shadows"),
    ).toBe("high");
  });
  it("gives projects saved before Geometry existed their shared tier instead of Custom", () => {
    const saved = (level: "low" | "ultra") => {
      const { geometry: _unsaved, ...quality } = normalizeRenderingQuality(qualityPresetPatch(level));
      void _unsaved;
      return quality;
    };
    const low = normalizeRenderingQuality(saved("low"));
    expect(low.geometry).toMatchObject({ lodDistanceScale: 0.5, preset: "low" });
    const mixed = normalizeRenderingQuality({ ...saved("ultra"), textures: saved("low").textures });
    expect(mixed.geometry).toMatchObject({ autoLod: true, lodDistanceScale: 1, preset: "medium" });
  });
  it("gives projects saved before Water (and before Geometry) their shared tier instead of Custom", () => {
    const saved = (level: "low" | "high" | "ultra", ...omit: ("geometry" | "water")[]) => {
      const quality: Record<string, unknown> = { ...normalizeRenderingQuality(qualityPresetPatch(level)) };
      for (const group of omit) delete quality[group];
      return quality;
    };
    const overall = (quality: unknown) => {
      const effective = resolveRenderingQuality({ quality: normalizeRenderingQuality(quality) });
      return QUALITY_GROUPS.filter((group) => group !== "shadows").map((group) => qualityGroupLabel(effective, group));
    };
    const beforeWater = normalizeRenderingQuality(saved("ultra", "water"));
    expect(beforeWater.water).toEqual({ ...RENDER_QUALITY_PROFILES.ultra.water, profile: "ultra", preset: "ultra" });
    expect(new Set(overall(saved("ultra", "water")))).toEqual(new Set(["ultra"]));
    const beforeGeometry = normalizeRenderingQuality(saved("low", "geometry", "water"));
    expect(beforeGeometry.geometry.preset).toBe("low");
    expect(beforeGeometry.water).toMatchObject({ shadingDetail: "low", refraction: false, preset: "low" });
    expect(new Set(overall(saved("low", "geometry", "water")))).toEqual(new Set(["low"]));
    // A saved Geometry group that targeted another tier means the project had no shared tier.
    const mixed = normalizeRenderingQuality({ ...saved("high", "water"), geometry: saved("low").geometry });
    expect(mixed.water).toMatchObject({ ...RENDER_QUALITY_PROFILES.medium.water, preset: "medium" });
  });
  it("fills water fields added by later releases from the saved water tier, not Medium", () => {
    const { profile, preset, shadingDetail, refraction } = qualityPresetPatch("high").water!;
    const quality = normalizeRenderingQuality({ water: { profile, preset, shadingDetail, refraction, reflections: "mirror" } });
    expect(quality.water).toEqual({ ...RENDER_QUALITY_PROFILES.high.water, profile: "high", preset: "high" });
    const low = normalizeRenderingQuality({ water: { profile: "low", meshDensity: 9, fftSize: 100, reflectionSteps: 3.6, contactResolution: 300.4 } });
    expect(low.water).toMatchObject({ meshDensity: 1.5, fftSize: 128, reflectionSteps: 4, contactResolution: 300, refraction: false, preset: "custom" });
  });
  it("sets, rejects and resets individual water settings from the console", () => {
    const session = new RenderingQualitySession();
    expect(session.execute("water", "refraction", "off").success).toBe(true);
    expect(session.execute("water", "reflections", "screenspace").success).toBe(true);
    expect(session.execute("water", "fftSize", "256").success).toBe(true);
    expect(session.execute("water", "meshDensity", "1.25").success).toBe(true);
    expect(session.effective().water).toMatchObject({
      refraction: false, reflections: "screenSpace", fftSize: 256, meshDensity: 1.25, preset: "custom",
    });
    for (const [field, value] of [["fftSize", "100"], ["reflectionSteps", "3.5"], ["meshDensity", "2"],
      ["reflections", "mirror"], ["fft", "yes"], ["contactResolution", "128"], ["octaves", "3"], ["meshDensity", ""]])
      expect(session.execute("water", field, value).success).toBe(false);
    expect(session.execute("geometry", "meshDensity", "1").success).toBe(false);
    expect(session.effective().water).toMatchObject({ fftSize: 256, meshDensity: 1.25, contactResolution: 512 });
    session.execute("water", "reset");
    expect(session.effective().water).toMatchObject({ ...RENDER_QUALITY_PROFILES.medium.water, preset: "medium" });
  });
  it("switches automatic LOD and its distance scale from the console", () => {
    const session = new RenderingQualitySession();
    expect(session.execute("geometry", "lod", "off").success).toBe(true);
    expect(session.execute("geometry", "distance", "2.5").success).toBe(true);
    expect(session.effective().geometry).toMatchObject({ autoLod: false, lodDistanceScale: 2.5, preset: "custom" });
    expect(session.execute("geometry", "distance", "10").success).toBe(false);
    expect(session.effective().geometry.lodDistanceScale).toBe(2.5);
    session.execute("geometry", "reset");
    expect(session.effective().geometry).toMatchObject({ autoLod: true, lodDistanceScale: 1 });
  });
  it("detects legacy mismatched shadow settings without overwriting their values", () => {
    const settings = normalizeProjectSettings({
      render: {
        ...DEFAULT_RENDER_PROJECT_SETTINGS,
        shadows: { distance: 321, maxLocalLights: 9, profile: "medium" },
      },
    } as never).render;
    expect(settings.shadows).toMatchObject({
      distance: 321,
      maxLocalLights: 9,
      localLightMode: "manual",
      preset: "custom",
    });
    expect(
      qualityGroupLabel(resolveRenderingQuality(settings), "shadows"),
    ).toBe("custom");
  });
  it.each([
    { enabled: false },
    { distance: 123 },
    { fadeFraction: 0.2 },
    { mapSize: 512 },
    { cascades: 3 },
    { filter: "pcss" as const },
    { filterQuality: "low" as const },
    { softness: 0.1 },
    { autoBias: false },
    { depthBias: 0.01 },
    { normalBias: 0.01 },
    { localLightMode: "manual" as const },
    { maxLocalLights: 5 },
    { localMapSize: 512 },
  ])("reports any edited shadow cost field as Custom: %j", (patch) => {
    const requested = resolveRenderingQuality({
      shadows: { ...qualityPresetPatch("medium").shadows, ...patch },
    });
    expect(qualityGroupLabel(requested, "shadows")).toBe("custom");
  });
  it("keeps artistic and structural settings independent from every preset", () => {
    const authored = {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      mode: "cel" as const,
      renderPath: "clusteredForward" as const,
      gpuBackend: "webgpu" as const,
      width: 1234,
      height: 567,
      blackBars: true,
      environmentLighting: {
        enabled: false,
        intensity: 3,
        rotationYDegrees: 90,
        celStrength: 0.5,
      },
    };
    for (const level of QUALITY_LEVELS) {
      const changed = applyProjectQualityPatch(
        authored,
        qualityPresetPatch(level),
      );
      expect(changed).toMatchObject({
        mode: "cel",
        renderPath: "clusteredForward",
        gpuBackend: "webgpu",
        width: 1234,
        height: 567,
        blackBars: true,
        environmentLighting: authored.environmentLighting,
      });
      for (const group of QUALITY_GROUPS)
        expect(qualityGroupLabel(resolveRenderingQuality(changed), group)).toBe(
          level,
        );
    }
  });
  it("does not display a low preset when malformed saved provenance still requests Ultra admission", () => {
    const patch = qualityPresetPatch("low");
    const quality = normalizeRenderingQuality(patch);
    const requested = resolveRenderingQuality({
      shadows: { ...patch.shadows, profile: "ultra" },
      quality: {
        ...quality,
        lighting: { ...quality.lighting, profile: "ultra" },
      },
    });
    expect(qualityGroupLabel(requested, "shadows")).toBe("custom");
    expect(qualityGroupLabel(requested, "lighting")).toBe("custom");
    expect(resolveLocalLightBudget(requested.lighting)).toBe(256);
  });
  it("honors Manual illumination requests above the Auto target until a preset is reapplied", () => {
    const session = new RenderingQualitySession();
    session.execute("lighting", "low");
    session.execute("lighting", "budget", "99");
    session.execute("shadows", "ultra");
    expect(resolveLocalLightBudget(session.effective().lighting)).toBe(99);
    expect(session.effective().lighting).toMatchObject({
      maxLocalLights: 99,
      preset: "custom",
      profile: "low",
    });
    expect(session.effective().shadows.maxLocalLights).toBe(8);
    session.execute("lighting", "budget", "auto");
    expect(resolveLocalLightBudget(session.effective().lighting)).toBe(4);
    expect(session.effective().lighting.maxLocalLights).toBe(99);
    session.execute("lighting", "medium");
    expect(resolveLocalLightBudget(session.effective().lighting)).toBe(16);
    expect(session.effective().lighting.maxLocalLights).toBe(16);
  });
});
