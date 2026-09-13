import { describe, expect, it } from "vitest";
import {
  QUALITY_GROUPS,
  QUALITY_LEVELS,
  qualityGroupLabel,
  RenderingQualitySession,
  resolveRenderingQuality,
} from "./render-quality";

describe("rendering quality sessions", () => {
  it("keeps authored distance and user budgets when applying overall or shadow presets", () => {
    const session = new RenderingQualitySession({
      shadows: { distance: 600, maxLocalLights: 9 },
    });
    session.execute(undefined, "low");
    expect(session.effective().shadows).toMatchObject({
      distance: 600,
      maxLocalLights: 9,
      mapSize: 1024,
    });
    session.execute("shadows", "budget", "12");
    session.execute("shadows", "ultra");
    expect(session.effective().shadows).toMatchObject({
      distance: 600,
      maxLocalLights: 12,
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
  it("switches runtime capacity between Manual and Auto while retaining the authored limit", () => {
    const session = new RenderingQualitySession();
    session.execute("shadows", "budget", "16");
    session.execute("shadows", "low");
    expect(session.effective().shadows).toMatchObject({
      localLightMode: "manual",
      maxLocalLights: 16,
      profile: "low",
    });
    expect(session.execute("shadows", "budget", "auto").success).toBe(true);
    expect(session.effective().shadows).toMatchObject({
      localLightMode: "auto",
      maxLocalLights: 16,
    });
    session.execute("shadows", "reset");
    expect(session.effective().shadows.localLightMode).toBe("auto");
  });
});
