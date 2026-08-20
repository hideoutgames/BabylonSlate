import { Mesh, StandardMaterial, Texture, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  applyEditorBillboardFromActor,
  createEditorBillboard,
  lightBillboardIcon,
  parseEditorBillboardIcon,
  resolveEditorBillboardIcon,
  syncEditorBillboardParentScale,
} from "./editor-billboard";
import { engineBillboardUrl } from "./default-billboard/urls";
import { RENDERING_GROUP } from "./sorting";

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

  it("parses dedicated and default billboard kinds", () => {
    expect(parseEditorBillboardIcon("billboard:default")).toBe("default");
    expect(parseEditorBillboardIcon("billboard:point_light")).toBe("point_light");
    expect(parseEditorBillboardIcon("billboard:spot_light")).toBe("spot_light");
    expect(parseEditorBillboardIcon("billboard:directional_light")).toBe(
      "directional_light",
    );
    expect(parseEditorBillboardIcon("billboard:camera")).toBe("camera");
    expect(parseEditorBillboardIcon("billboard:audio")).toBe("audio");
    expect(parseEditorBillboardIcon("billboard:particle")).toBe("particle");
    expect(parseEditorBillboardIcon("billboard:navmesh")).toBe("navmesh");
    expect(parseEditorBillboardIcon("billboard:light")).toBe("point_light");
    expect(parseEditorBillboardIcon("billboard:rigidbody")).toBe("default");
    expect(parseEditorBillboardIcon("billboard:nope")).toBeNull();
    expect(parseEditorBillboardIcon("box")).toBeNull();
    expect(parseEditorBillboardIcon(null)).toBeNull();
  });

  it("falls unknown helper icons back to default", () => {
    expect(resolveEditorBillboardIcon("nope")).toBe("default");
    expect(resolveEditorBillboardIcon(undefined)).toBe("default");
    expect(resolveEditorBillboardIcon("spot_light")).toBe("spot_light");
  });

  it("maps LightComponent lightKind onto dedicated PNGs", () => {
    expect(lightBillboardIcon("point")).toBe("point_light");
    expect(lightBillboardIcon("spot")).toBe("spot_light");
    expect(lightBillboardIcon("directional")).toBe("directional_light");
    expect(lightBillboardIcon("other")).toBe("point_light");
  });

  it("creates a pickable camera-facing unlit icon quad from the engine PNG", () => {
    const { scene } = createHandle();
    const mesh = createEditorBillboard(scene, "editorActor:lamp", "point_light");
    expect(mesh.name).toBe("editorActor:lamp");
    expect(mesh.isPickable).toBe(true);
    expect(mesh.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (mesh.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("point_light");
    const material = mesh.material as StandardMaterial;
    expect(material.disableLighting).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    const texture = material.emissiveTexture as Texture;
    expect(texture.url).toContain(engineBillboardUrl("point_light").slice(1));
    expect(mesh.renderingGroupId).toBe(RENDERING_GROUP.foreground);
  });

  it("tints a light billboard from LightComponent color", () => {
    const { scene } = createHandle();
    const mesh = createEditorBillboard(scene, "editorActor:lamp", "spot_light");
    applyEditorBillboardFromActor(
      mesh,
      createActor("lamp", "Lamp", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { color: [0.2, 0.5, 1], lightKind: "spot" },
          },
        ],
      }),
    );
    const material = mesh.material as StandardMaterial;
    expect(material.emissiveColor.r).toBeCloseTo(0.2);
    expect(material.emissiveColor.g).toBeCloseTo(0.5);
    expect(material.emissiveColor.b).toBeCloseTo(1);
  });

  it("stays square when parented under non-uniform actor scale", () => {
    const { scene } = createHandle();
    const parent = new TransformNode("origin", scene);
    parent.scaling.set(3, 2, 4);
    const mesh = createEditorBillboard(scene, "editorActor:empty", "default");
    mesh.parent = parent;
    syncEditorBillboardParentScale(mesh);
    mesh.computeWorldMatrix(true);
    expect(mesh.absoluteScaling.x).toBeCloseTo(1);
    expect(mesh.absoluteScaling.y).toBeCloseTo(1);
    expect(mesh.absoluteScaling.z).toBeCloseTo(1);
  });
});
