import { describe, expect, it } from "vitest";
import type { SerializedPin } from "./graph-types";
import { pinDefaultPreview } from "./pin-default-preview";

function pin(
  partial: Pick<SerializedPin, "id" | "name" | "kind" | "direction" | "type">,
): SerializedPin {
  return partial;
}

const condition = pin({
  id: "condition",
  name: "condition",
  kind: "data",
  direction: "in",
  type: { kind: "bool" },
});

const message = pin({
  id: "message",
  name: "message",
  kind: "data",
  direction: "in",
  type: { kind: "string" },
});

const amount = pin({
  id: "a",
  name: "a",
  kind: "data",
  direction: "in",
  type: { kind: "float" },
});

const execIn = pin({
  id: "execIn",
  name: "exec",
  kind: "exec",
  direction: "in",
  type: { kind: "exec" },
});

const target = pin({
  id: "target",
  name: "target",
  kind: "data",
  direction: "in",
  type: { kind: "objectRef", classId: "Actor" },
});

const thenOut = pin({
  id: "then",
  name: "then",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
});

const resultOut = pin({
  id: "result",
  name: "result",
  kind: "data",
  direction: "out",
  type: { kind: "float" },
});

describe("pinDefaultPreview", () => {
  it("returns an unchecked bool when the pin has no authored default", () => {
    expect(pinDefaultPreview(condition, {}, false)).toEqual({
      kind: "bool",
      checked: false,
    });
  });

  it("returns a checked bool from default:name", () => {
    expect(
      pinDefaultPreview(condition, { "default:condition": true }, false),
    ).toEqual({ kind: "bool", checked: true });
  });

  it("prefers default:name over a colliding bare property", () => {
    expect(
      pinDefaultPreview(
        condition,
        { "default:condition": true, condition: false },
        false,
      ),
    ).toEqual({ kind: "bool", checked: true });
  });

  it("returns an empty string field when no default is authored", () => {
    expect(pinDefaultPreview(message, {}, false)).toEqual({
      kind: "string",
      text: "",
    });
  });

  it("returns the authored string default without truncating", () => {
    expect(
      pinDefaultPreview(
        message,
        { "default:message": "a very long hello world string" },
        false,
      ),
    ).toEqual({
      kind: "string",
      text: "a very long hello world string",
    });
  });

  it("returns a compact number field for float defaults", () => {
    expect(pinDefaultPreview(amount, {}, false)).toEqual({
      kind: "float",
      text: "0",
    });
    expect(pinDefaultPreview(amount, { "default:a": 1.5 }, false)).toEqual({
      kind: "float",
      text: "1.5",
    });
  });

  it("joins vector and rotator defaults into one comma-separated field", () => {
    const location = pin({
      id: "location",
      name: "location",
      kind: "data",
      direction: "in",
      type: { kind: "vec3" },
    });
    const rotation = pin({
      id: "rotation",
      name: "rotation",
      kind: "data",
      direction: "in",
      type: { kind: "rotator" },
    });
    expect(
      pinDefaultPreview(
        location,
        { "default:location": { x: 1, y: 2, z: 3 } },
        false,
      ),
    ).toEqual({ kind: "vec3", text: "1, 2, 3" });
    expect(
      pinDefaultPreview(
        rotation,
        { "default:rotation": { pitch: 10, yaw: 20, roll: 30 } },
        false,
      ),
    ).toEqual({ kind: "rotator", text: "10, 20, 30" });
    const orientation = pin({
      id: "orientation",
      name: "orientation",
      kind: "data",
      direction: "in",
      type: { kind: "quat" },
    });
    expect(
      pinDefaultPreview(
        orientation,
        { "default:orientation": [0, 0, 0, 1] },
        false,
      ),
    ).toEqual({ kind: "quat", text: "0, 0, 0, 1" });
  });

  it("returns an rgb swatch for color defaults", () => {
    const tint = pin({
      id: "tint",
      name: "tint",
      kind: "data",
      direction: "in",
      type: { kind: "color" },
    });
    expect(
      pinDefaultPreview(
        tint,
        { "default:tint": { x: 1, y: 0.5, z: 0, w: 1 } },
        false,
      ),
    ).toEqual({ kind: "color", rgb: "rgb(255, 128, 0)" });
  });

  it("returns class and enum names in a text field", () => {
    const classPin = pin({
      id: "classId",
      name: "classId",
      kind: "data",
      direction: "in",
      type: { kind: "classRef", classId: "Actor" },
    });
    const enumPin = pin({
      id: "mode",
      name: "mode",
      kind: "data",
      direction: "in",
      type: { kind: "enumRef", guid: "e1" },
    });
    expect(pinDefaultPreview(classPin, {}, false)).toEqual({
      kind: "classRef",
      text: "Actor",
    });
    expect(
      pinDefaultPreview(enumPin, { "default:mode": "Walk" }, false),
    ).toEqual({ kind: "enumRef", text: "Walk" });
  });

  it("returns an assetRef guid in a text field", () => {
    const assetPin = pin({
      id: "asset",
      name: "asset",
      kind: "data",
      direction: "in",
      type: { kind: "assetRef", assetType: "Audio" },
    });
    expect(
      pinDefaultPreview(assetPin, { "default:asset": "audio-1" }, false),
    ).toEqual({ kind: "assetRef", text: "audio-1" });
  });

  it("returns null when the pin is connected", () => {
    expect(
      pinDefaultPreview(condition, { "default:condition": true }, true),
    ).toBeNull();
    expect(
      pinDefaultPreview(message, { "default:message": "hi" }, true),
    ).toBeNull();
  });

  it("returns null for exec, outputs, and live object refs", () => {
    expect(pinDefaultPreview(execIn, {}, false)).toBeNull();
    expect(pinDefaultPreview(thenOut, {}, false)).toBeNull();
    expect(pinDefaultPreview(resultOut, { "default:result": 4 }, false)).toBeNull();
    expect(pinDefaultPreview(target, { "default:target": "Hero" }, false)).toBeNull();
  });

  it("previews a generic input as a float field", () => {
    const generic = pin({
      id: "a",
      name: "A",
      kind: "data",
      direction: "in",
      type: { kind: "generic" },
    });
    expect(pinDefaultPreview(generic, {}, false)).toEqual({
      kind: "float",
      text: "0",
    });
    expect(
      pinDefaultPreview(generic, { "default:a": [1.5] }, false),
    ).toEqual({ kind: "float", text: "1.5" });
  });

  it("uses catalog defaultValue number arrays when nothing is authored", () => {
    const roughness: SerializedPin = {
      id: "roughness",
      name: "Roughness",
      kind: "data",
      direction: "in",
      type: { kind: "float" },
      defaultValue: [0.5],
    };
    expect(pinDefaultPreview(roughness, {}, false)).toEqual({
      kind: "float",
      text: "0.5",
    });
  });

  it("reads default:pinId when the display name differs", () => {
    const metallic: SerializedPin = {
      id: "metallic",
      name: "Metallic",
      kind: "data",
      direction: "in",
      type: { kind: "float" },
      defaultValue: [0],
    };
    expect(
      pinDefaultPreview(metallic, { "default:metallic": [0.8] }, false),
    ).toEqual({ kind: "float", text: "0.8" });
  });

  it("renders a color swatch for colorHint vector pins from number arrays", () => {
    const baseColor: SerializedPin = {
      id: "baseColor",
      name: "Base Color",
      kind: "data",
      direction: "in",
      type: { kind: "vec3" },
      colorHint: true,
      defaultValue: [0.8, 0.8, 0.8],
    };
    expect(pinDefaultPreview(baseColor, {}, false)).toEqual({
      kind: "color",
      rgb: "rgb(204, 204, 204)",
    });
    expect(
      pinDefaultPreview(baseColor, {}, true),
    ).toBeNull();
  });

  it("joins vec2 number-array defaults", () => {
    const tiling: SerializedPin = {
      id: "tiling",
      name: "Tiling",
      kind: "data",
      direction: "in",
      type: { kind: "vec2" },
      defaultValue: [1, 1],
    };
    expect(pinDefaultPreview(tiling, {}, false)).toEqual({
      kind: "vec2",
      text: "1, 1",
    });
  });

  it("returns null for texture pins", () => {
    const texture = pin({
      id: "texture",
      name: "Texture",
      kind: "data",
      direction: "in",
      type: { kind: "texture" },
    });
    expect(pinDefaultPreview(texture, {}, false)).toBeNull();
  });
});
