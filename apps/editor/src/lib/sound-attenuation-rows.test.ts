import { describe, expect, it, vi } from "vitest";
import { createDefaultSoundAttenuationPayload } from "@babylonslate/assets";
import { soundAttenuationDetailRows } from "./sound-attenuation-rows";

describe("soundAttenuationDetailRows", () => {
  it("exposes cone and Doppler fields so 3D setup can be authored", () => {
    const commit = vi.fn();
    const rows = soundAttenuationDetailRows(
      createDefaultSoundAttenuationPayload(),
      commit,
    );
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        "innerRadius",
        "maxRadius",
        "distanceModel",
        "rolloff",
        "spatialisation",
        "coneEnabled",
        "dopplerEnabled",
      ]),
    );
    expect(rows.find((row) => row.id === "coneEnabled")).toMatchObject({
      kind: "boolean",
      label: "Cone",
      value: false,
    });
    expect(rows.find((row) => row.id === "dopplerEnabled")).toMatchObject({
      kind: "boolean",
      label: "Doppler",
      value: false,
    });
    expect(rows.find((row) => row.id === "coneInnerAngle")).toBeUndefined();
  });

  it("shows cone angles and Doppler factor when those extras are enabled", () => {
    const commit = vi.fn();
    const rows = soundAttenuationDetailRows(
      {
        ...createDefaultSoundAttenuationPayload(),
        cone: { innerAngle: 90, outerAngle: 120, outerGain: 0.25 },
        doppler: { enabled: true, factor: 1 },
      },
      commit,
    );
    expect(rows.find((row) => row.id === "coneInnerAngle")).toMatchObject({
      kind: "number",
      label: "Inner Angle",
      value: 90,
    });
    expect(rows.find((row) => row.id === "coneOuterAngle")).toMatchObject({
      kind: "number",
      label: "Outer Angle",
      value: 120,
    });
    expect(rows.find((row) => row.id === "coneOuterGain")).toMatchObject({
      kind: "number",
      label: "Outer Gain",
      value: 0.25,
    });
    expect(rows.find((row) => row.id === "dopplerFactor")).toMatchObject({
      kind: "number",
      label: "Doppler Factor",
      value: 1,
    });
  });
});
