import { afterEach, describe, expect, it } from "vitest";
import { DirectionalLight, MeshBuilder, NullEngine, PointLight, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";
import { normalizeShadowSettings } from "@babylonslate/core";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function fixture() {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1 }) });
  return { scene, controller: sceneShadowController(scene) };
}
describe("shared shadow lifecycle", () => {
  it("registers late meshes and releases removed meshes and disabled light allocations", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true); controller.sync();
    const added = new Promise<void>((resolve) => scene.onNewMeshAddedObservable.addOnce(() => resolve()));
    const mesh = MeshBuilder.CreateBox("spawned", {}, scene);
    await added;
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(mesh);
    expect(mesh.receiveShadows).toBe(true);
    controller.setParticipation(mesh, { castShadows: false, receiveShadows: true }); controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).not.toContain(mesh);
    expect(mesh.receiveShadows).toBe(true);
    controller.setParticipation(mesh, { castShadows: true, receiveShadows: false }); controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(mesh);
    expect(mesh.receiveShadows).toBe(false);
    mesh.dispose();
    expect(controller.generator(light)?.getShadowMap()?.renderList).not.toContain(mesh);
    light.setEnabled(false); controller.sync();
    expect(controller.generator(light)).toBeNull();
    light.setEnabled(true); controller.sync();
    expect(controller.generator(light)).not.toBeNull();
    controller.register(light, false); controller.sync();
    expect(controller.generator(light)).toBeNull();
  });
  it("budgets local lights separately and transfers capacity when an owner is disabled", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("a", Vector3.Zero(), scene);
    const b = new PointLight("b", Vector3.Zero(), scene);
    controller.register(a, true); controller.register(b, true); controller.sync();
    expect(controller.diagnostics().map((light) => light.status)).toEqual(["active", "budget-limited"]);
    a.setEnabled(false); controller.sync();
    expect(controller.diagnostics().map((light) => light.status)).toEqual(["disabled", "active"]);
    expect(controller.diagnostics()[1]?.passes).toBe(6);
  });
  it("keeps helper meshes out of shadow maps and responds to camera replacement", () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    const helper = MeshBuilder.CreateBox("__helper", {}, scene);
    controller.register(light, true); controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).not.toContain(helper);
    const previous = controller.generator(light);
    scene.activeCamera = new UniversalCamera("possessed", Vector3.Zero(), scene);
    controller.sync();
    expect(controller.generator(light)).not.toBe(previous);
  });
});
