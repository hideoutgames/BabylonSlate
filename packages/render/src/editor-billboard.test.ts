import { Mesh, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  applyEditorBillboardFromActor,
  createEditorBillboard,
  parseEditorBillboardIcon,
} from "./editor-billboard";

describe("editor billboard", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("parses only known billboard kinds", () => {
    expect(parseEditorBillboardIcon("billboard:light")).toBe("light");
    expect(parseEditorBillboardIcon("billboard:camera")).toBe("camera");
    expect(parseEditorBillboardIcon("billboard:audio")).toBe("audio");
    expect(parseEditorBillboardIcon("billboard:particle")).toBe("particle");
    expect(parseEditorBillboardIcon("billboard:nope")).toBeNull();
    expect(parseEditorBillboardIcon("box")).toBeNull();
    expect(parseEditorBillboardIcon(null)).toBeNull();
  });

  it("creates a pickable camera-facing unlit icon quad", () => {
    const { scene } = createHandle();
    const mesh = createEditorBillboard(scene, "editorActor:lamp", "light");
    expect(mesh.name).toBe("editorActor:lamp");
    expect(mesh.isPickable).toBe(true);
    expect(mesh.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (mesh.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("light");
    const material = mesh.material as StandardMaterial;
    expect(material.disableLighting).toBe(true);
    expect(material.backFaceCulling).toBe(false);
  });

  it("tints a light billboard from LightComponent color", () => {
    const { scene } = createHandle();
    const mesh = createEditorBillboard(scene, "editorActor:lamp", "light");
    applyEditorBillboardFromActor(
      mesh,
      createActor("lamp", "Lamp", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { color: [0.2, 0.5, 1] },
          },
        ],
      }),
    );
    const material = mesh.material as StandardMaterial;
    expect(material.emissiveColor.r).toBeCloseTo(0.2);
    expect(material.emissiveColor.g).toBeCloseTo(0.5);
    expect(material.emissiveColor.b).toBeCloseTo(1);
  });
});
