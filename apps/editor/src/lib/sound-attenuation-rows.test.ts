import { describe, expect, it, vi } from "vitest";
import { createDefaultSoundAttenuationPayload, type SoundAttenuationPayload } from "@haptic/assets";
import { soundAttenuationDetailRows } from "./sound-attenuation-rows";

type Row = ReturnType<typeof soundAttenuationDetailRows>[number];

function rows(attenuation: SoundAttenuationPayload, name: (guid: string) => string | undefined = () => undefined) {
  const commit = vi.fn();
  const pick = vi.fn();
  const list = soundAttenuationDetailRows(attenuation, commit, pick, name);
  const byId = (id: string) => list.find((row) => row.id === id) as Row & Record<string, unknown>;
  const change = (id: string, value: unknown) => (byId(id) as unknown as { onChange(value: unknown): void }).onChange(value);
  return { list, ids: list.map((row) => row.id), byId, change, commit, pick };
}

describe("Sound Attenuation Details rows", () => {
  it("offers the built-in falloffs and Custom, with no Rolloff, and the curve row only for Custom", () => {
    const attenuation = createDefaultSoundAttenuationPayload();
    const { ids, byId } = rows(attenuation);
    expect(ids).toEqual(["innerRadius", "maxRadius", "falloff", "spatialisation", "coneEnabled", "dopplerEnabled"]);
    expect(byId("falloff")).toMatchObject({
      label: "Falloff",
      value: "natural",
      options: [
        { value: "natural", label: "Natural" },
        { value: "linear", label: "Linear" },
        { value: "inverse", label: "Inverse" },
        { value: "exponential", label: "Exponential" },
        { value: "custom", label: "Custom" },
      ],
    });
    expect(rows({ ...attenuation, falloff: "custom" }).ids).toEqual([
      "innerRadius", "maxRadius", "falloff", "falloffCurveGuid", "spatialisation", "coneEnabled", "dopplerEnabled",
    ]);
  });

  it("picks the Custom curve, names it, and says when it is missing or not picked", () => {
    const custom = { ...createDefaultSoundAttenuationPayload(), falloff: "custom" as const, falloffCurveGuid: "fade" };
    const picked = rows(custom, (guid) => (guid === "fade" ? "Fade" : undefined));
    expect(picked.byId("falloffCurveGuid")).toMatchObject({
      label: "Falloff Curve", value: "fade", displayLabel: "Fade", displayType: "Float Curve", assetTypes: ["FloatCurve"],
    });
    expect(picked.byId("falloffCurveGuid").status).toBeUndefined();
    (picked.byId("falloffCurveGuid") as unknown as { onPick(): void }).onPick();
    expect(picked.pick).toHaveBeenCalledOnce();
    picked.change("falloffCurveGuid", null);
    expect(picked.commit).toHaveBeenLastCalledWith({ ...custom, falloffCurveGuid: null });

    const missing = rows(custom);
    expect(missing.byId("falloffCurveGuid")).toMatchObject({ displayLabel: "Missing Curve", status: "Falls off as Natural until a Float Curve is picked." });
    const none = rows({ ...custom, falloffCurveGuid: null });
    expect(none.byId("falloffCurveGuid")).toMatchObject({ status: "Falls off as Natural until a Float Curve is picked." });
    expect(none.byId("falloffCurveGuid").displayLabel).toBeUndefined();
  });

  it("stops a radius at the other instead of swapping them", () => {
    const attenuation = { ...createDefaultSoundAttenuationPayload(), innerRadius: 10, maxRadius: 20 };
    const { change, commit } = rows(attenuation);
    change("innerRadius", 35);
    expect(commit).toHaveBeenLastCalledWith({ ...attenuation, innerRadius: 20 }, "innerRadius");
    change("innerRadius", 4);
    expect(commit).toHaveBeenLastCalledWith({ ...attenuation, innerRadius: 4 }, "innerRadius");
    change("maxRadius", 2);
    expect(commit).toHaveBeenLastCalledWith({ ...attenuation, maxRadius: 10 }, "maxRadius");
    change("maxRadius", 40);
    expect(commit).toHaveBeenLastCalledWith({ ...attenuation, maxRadius: 40 }, "maxRadius");
  });

  it("stops a cone angle at the other instead of pushing it", () => {
    const attenuation = { ...createDefaultSoundAttenuationPayload(), cone: { innerAngle: 90, outerAngle: 120, outerGain: 0 } };
    const { change, commit } = rows(attenuation);
    change("coneInnerAngle", 200);
    expect(commit).toHaveBeenLastCalledWith({ ...attenuation, cone: { innerAngle: 120, outerAngle: 120, outerGain: 0 } }, "cone.innerAngle");
    change("coneOuterAngle", 30);
    expect(commit).toHaveBeenLastCalledWith({ ...attenuation, cone: { innerAngle: 90, outerAngle: 90, outerGain: 0 } }, "cone.outerAngle");
  });
});
