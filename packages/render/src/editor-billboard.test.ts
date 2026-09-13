import { DirectionalLight, Mesh, PointLight, StandardMaterial, Texture, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, normalizeShadowSettings } from "@babylonslate/core";
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
import { setAuthoredLightEnabled, syncDirectionalLightPolicy } from "./light-policy";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";

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
    const texture = material.diffuseTexture as Texture;
    expect(material.emissiveTexture).toBeNull();
    expect(texture.url).toContain(engineBillboardUrl("point_light").slice(1));
    expect(mesh.renderingGroupId).toBe(RENDERING_GROUP.foreground);
  });

  it.each(["pbr", "cel"] as const)("uses white for normal light billboards and preserves authored RGB in %s", (mode) => {
    const { scene } = createHandle();
    updateSceneRenderingSettings(scene, { mode });
    const mesh = createEditorBillboard(scene, "editorActor:lamp", "spot_light");
    const actor = createActor("lamp", "Lamp", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { color: [0.2, 0.5, 1], lightKind: "spot" },
          },
        ],
      });
    applyEditorBillboardFromActor(mesh, actor);
    const material = mesh.material as StandardMaterial;
    expect(material.emissiveColor.asArray()).toEqual([1, 1, 1]);
    expect(actor.components[0]?.properties.color).toEqual([0.2, 0.5, 1]);
  });

  it.each(["pbr", "cel"] as const)("distinguishes intentionally unshadowed, limited, active and disabled lights in %s", (mode) => {
    const { scene } = createHandle();
    updateSceneRenderingSettings(scene, { mode, shadows: normalizeShadowSettings({ localLightMode: "manual", maxLocalLights: 0 }) });
    const light = new PointLight("authoredLight:lamp", Vector3.Zero(), scene);
    const controller = sceneShadowController(scene);
    const actor = createActor("lamp", "Lamp", { components: [{ id: "light", classId: "LightComponent", properties: { color: [1, 0.3, 0.1], castShadows: false } }] });
    const mesh = createEditorBillboard(scene, "editorActor:lamp", "point_light");
    const color = () => (mesh.material as StandardMaterial).emissiveColor.asArray();
    controller.register(light, false);
    applyEditorBillboardFromActor(mesh, actor);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(color()).toEqual([1, 1, 1]);
    actor.components[0]!.properties.castShadows = true;
    controller.register(light, true);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(color()).toEqual([1, 1, 0]);
    updateSceneRenderingSettings(scene, { mode, shadows: normalizeShadowSettings({ localLightMode: "manual", maxLocalLights: 1 }) });
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(color()).toEqual([1, 1, 1]);
    light.intensity = 0;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(color()).toEqual([1, 0, 0]);
  });

  it("updates red and yellow status as directional illumination ownership changes", () => {
    const { scene } = createHandle();
    const first = new DirectionalLight("authoredLight:first", Vector3.Down(), scene);
    const second = new DirectionalLight("authoredLight:second", Vector3.Down(), scene);
    setAuthoredLightEnabled(first, true);
    setAuthoredLightEnabled(second, true);
    const icon = createEditorBillboard(scene, "editorActor:second", "directional_light");
    applyEditorBillboardFromActor(icon, createActor("second", "Second", { components: [{ id: "light", classId: "LightComponent", properties: { enabled: true, lightKind: "directional", castShadows: true } }] }));
    const material = icon.material as StandardMaterial;
    expect(material.emissiveColor.asArray()).toEqual([1, 0, 0]);
    expect(second.isEnabled()).toBe(false);
    setAuthoredLightEnabled(first, false);
    syncDirectionalLightPolicy(scene);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(second.isEnabled()).toBe(true);
    expect(material.emissiveColor.asArray()).toEqual([1, 1, 0]);
    icon.dispose();
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
