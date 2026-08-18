import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument } from "./document";
import {
  listUnconnectedMaterialPinDefaults,
  materialPinDefaultPropertyKey,
  readMaterialPinDefault,
} from "./pin-defaults";

describe("material pin defaults", () => {
  it("keys authored overrides by pin id", () => {
    expect(materialPinDefaultPropertyKey("roughness")).toBe("default:roughness");
  });

  it("reads an authored number-array override", () => {
    expect(
      readMaterialPinDefault({ "default:roughness": [0.8] }, "roughness"),
    ).toEqual([0.8]);
    expect(readMaterialPinDefault({}, "roughness")).toBeUndefined();
  });

  it("lists catalog defaults for unconnected numeric and color pins", () => {
    const doc = createDefaultMaterialDocument();
    const listed = listUnconnectedMaterialPinDefaults(doc, "output");
    const byId = Object.fromEntries(listed.map((row) => [row.pinId, row]));
    expect(byId.baseColor).toBeUndefined();
    expect(byId.metallic).toMatchObject({
      name: "Metallic",
      type: "float",
      value: [0],
    });
    expect(byId.roughness).toMatchObject({
      name: "Roughness",
      type: "float",
      value: [0.5],
    });
    expect(byId.emissive).toMatchObject({
      colorHint: true,
      value: [0, 0, 0],
    });
    expect(byId.worldPositionOffset).toMatchObject({
      name: "World Position Offset",
      type: "vec3",
      value: [0, 0, 0],
    });
    expect(byId.normal).toBeUndefined();
  });

  it("uses the authored override and omits a pin once it is wired", () => {
    const doc = createDefaultMaterialDocument();
    const output = doc.nodes.find((node) => node.id === "output")!;
    output.properties = { "default:metallic": [0.25] };
    const listed = listUnconnectedMaterialPinDefaults(doc, "output");
    expect(listed.find((row) => row.pinId === "metallic")?.value).toEqual([
      0.25,
    ]);
    expect(listed.some((row) => row.pinId === "baseColor")).toBe(false);
  });
});
