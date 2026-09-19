import { afterEach, describe, expect, it } from "vitest";
import {
  MeshBuilder,
  PointLight,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  lightMobility,
  meshBakeParticipation,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { prepareSceneBake } from "./scene-bake-preparation";
import { snapshotBakeMesh } from "./bake-mesh-snapshot";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function fixture() {
  const { engine, scene } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => {
    sync.dispose();
    scene.dispose();
    engine.dispose();
  });
  const material = createDefaultMaterialDocument();
  material.twoSided = true;
  material.nodes[0].properties.value = [0.1, 0.3, 0.7];
  const document = createDefaultScene();
  const mesh = createMeshComponent("mesh", "ground");
  mesh.properties.materialGuid = "material-1";
  mesh.properties.bakeParticipation = "staticReceiver";
  document.actors = [
    createActor("receiver", "Ground", {
      transform: { ...identitySerializedTransform(), scale: [0.2, 0.2, 0.2] },
      components: [mesh],
    }),
    createActor("lamp", "Lamp", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [
        {
          id: "light",
          classId: "LightComponent",
          properties: { mobility: "static", intensity: 4 },
        },
      ],
    }),
    createActor("stationary", "Stationary", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [
        {
          id: "light",
          classId: "LightComponent",
          properties: { mobility: "stationary", intensity: 2 },
        },
      ],
    }),
    createActor("dynamic", "Dynamic", {
      components: [
        {
          id: "light",
          classId: "LightComponent",
          properties: { intensity: 16 },
        },
      ],
    }),
  ];
  sync.apply(document);
  const owner = { sceneGuid: "scene-1", generation: 1 };
  const options = {
    owner,
    current: () => owner,
    document,
    meshForComponent: (actorId: string, componentId: string) => sync.meshForComponent(actorId, componentId),
    materials: new Map([["material-1", material]]),
    settings: { resolution: 32, paddingTexels: 2, samples: 1, bounces: 2 },
  };
  return { scene, engine, sync, document, material, owner, options };
}

describe("authored Scene bake preparation", () => {
  it("resolves multiple primitive visuals by authored component identity instead of their renderer order", async () => {
    const { document, sync, options } = fixture();
    const second = createMeshComponent("second-mesh", "box");
    second.properties = { ...second.properties, materialGuid: "material-1", bakeParticipation: "staticReceiver" };
    document.actors[0].components.push(second);
    sync.apply(document);
    const prepared = await prepareSceneBake(options);
    expect(prepared.meshes.map((mesh) => [mesh.identity.componentId, mesh.source.indices.length])).toEqual([["mesh", 6], ["second-mesh", 36]]);
    expect(sync.meshForComponent("receiver", "missing")).toBeNull();
    expect(sync.meshForComponent("lamp", "light")).toBeNull();
  });
  it("captures actual authored primitive identity and calibrated Static/Stationary point inputs without changing realtime lights", async () => {
    expect(lightMobility({})).toBe("dynamic");
    expect(meshBakeParticipation({})).toBe("none");
    const { options, scene } = fixture();
    const count = scene.lights.filter((light) => light.isEnabled()).length;
    const editorOwner = { ...options.owner, isCurrent: () => true, commit: () => true };
    const prepared = await prepareSceneBake({ ...options, owner: editorOwner });
    expect(structuredClone(prepared.owner)).toEqual(options.owner);
    expect(prepared.meshes[0].identity).toEqual({
      actorId: "receiver",
      componentId: "mesh",
      primitive: { kind: "mesh" },
    });
    expect(
      prepared.batches.map((batch) => [batch.mode, batch.lights[0].intensity]),
    ).toEqual([
      ["full", 4],
      ["indirect", 2],
    ]);
    expect(prepared.sources).toHaveLength(2);
    expect(scene.lights.filter((light) => light.isEnabled())).toHaveLength(
      count,
    );
    const native = scene.lights.find(
      (light) => light instanceof PointLight && light.intensity === 4,
    )!;
    expect(native.getScaledIntensity()).toBe(4);
    const positions = prepared.meshes[0].transport.positions;
    const a = Vector3.FromArray(positions, 0),
      b = Vector3.FromArray(positions, 3),
      c = Vector3.FromArray(positions, 6);
    expect(
      Vector3.Cross(b.subtract(a), c.subtract(a)).normalize().y,
    ).toBeCloseTo(1);
    expect(Math.max(...positions)).toBeCloseTo(1);
    // Independent point equation at the surface center: I*cos(theta)/distance^2.
    expect(
      prepared.batches[0].lights[0].intensity /
        prepared.batches[0].lights[0].position[1] ** 2,
    ).toBe(1);
  });

  it("owns snapshots before hashing and rejects cancellation or obsolete Scene owners", async () => {
    const { options, owner, document, material } = fixture();
    const baseline = await prepareSceneBake(options);
    const pending = prepareSceneBake(options);
    document.actors[0].transform.position[0] = 8;
    material.nodes[0].properties.value = [1, 0, 0];
    const captured = await pending;
    expect(captured.inputs).toEqual(baseline.inputs);
    expect(captured.meshes[0].transport.material.albedo).toEqual([
      0.1, 0.3, 0.7,
    ]);
    const changed = await prepareSceneBake(options);
    expect(changed.inputs.transforms).not.toBe(baseline.inputs.transforms);
    expect(changed.inputs.materials).not.toBe(baseline.inputs.materials);
    const stale = prepareSceneBake(options);
    owner.generation++;
    await expect(stale).rejects.toThrow("Scene changed");
    const abort = new AbortController();
    const cancelled = prepareSceneBake({ ...options, signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses authored attachment transforms instead of a camera-relative or stale live world matrix", async () => {
    const { options, document, sync } = fixture();
    document.actors.push(
      createActor("parent", "Parent", {
        transform: {
          ...identitySerializedTransform(),
          position: [3, 0, 0],
          scale: [-1, 1, 1],
        },
      }),
    );
    document.actors[0].parentId = "parent";
    sync.meshForActor("receiver")!.position.x = 70;
    const prepared = await prepareSceneBake(options);
    expect(prepared.batches[0].lights[0].position).toEqual([0, 2, 0]);
    const positions = prepared.meshes[0].transport.positions;
    const xs = Array.from(positions).filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(2);
    expect(Math.max(...xs)).toBeCloseTo(4);
    const a = Vector3.FromArray(positions),
      b = Vector3.FromArray(positions, 3),
      c = Vector3.FromArray(positions, 6);
    expect(
      Vector3.Cross(b.subtract(a), c.subtract(a)).normalize().y,
    ).toBeCloseTo(1);
    document.actors[1].parentId = "parent";
    await expect(prepareSceneBake(options)).rejects.toThrow(
      "attachment parity",
    );
  });

  it("invalidates relevant light, UV, geometry and settings inputs while ignoring display labels", async () => {
    const { options, document, sync } = fixture();
    const initial = await prepareSceneBake(options);
    document.actors[0].name = "Only a label";
    expect((await prepareSceneBake(options)).inputs).toEqual(initial.inputs);
    document.actors[1].components[0].properties.color = [0.2, 0.3, 0.4];
    expect((await prepareSceneBake(options)).inputs.lights).not.toBe(
      initial.inputs.lights,
    );
    const mesh = sync.meshForActor("receiver")!;
    mesh.setVerticesData("uv2", [0, 0, 1, 0, 0, 1, 1, 1]);
    const uv = await prepareSceneBake(options);
    expect(uv.inputs.uv).not.toBe(initial.inputs.uv);
    const positions = [...mesh.getVerticesData("position")!];
    positions[0] += 0.5;
    mesh.setVerticesData("position", positions);
    expect((await prepareSceneBake(options)).inputs.geometry).not.toBe(
      uv.inputs.geometry,
    );
    expect(
      (
        await prepareSceneBake({
          ...options,
          settings: { ...options.settings, samples: 2 },
        })
      ).inputs.settings,
    ).not.toBe(initial.inputs.settings);
  });

  it("rejects moving ancestors for receivers and baked lights while admitting fixed static bodies", async () => {
    const { options, document } = fixture();
    const parent = createActor("moving-parent", "Moving Parent", {
      components: [
        {
          id: "body",
          classId: "RigidBodyComponent",
          properties: { motionType: "dynamic" },
        },
      ],
    });
    document.actors.push(parent);
    document.actors[0].parentId = parent.id;
    await expect(prepareSceneBake(options)).rejects.toThrow(
      "through Moving Parent",
    );
    parent.components[0].properties.motionType = "static";
    await expect(prepareSceneBake(options)).resolves.toMatchObject({
      owner: options.owner,
    });
    document.actors[0].parentId = null;
    document.actors[1].parentId = parent.id;
    parent.components[0] = {
      id: "animation",
      classId: "AnimationGraphComponent",
      properties: {},
    };
    await expect(prepareSceneBake(options)).rejects.toThrow(
      "through Moving Parent",
    );
  });

  it("matches mesh visibility and light Enabled independently of hidden actor/ancestor visuals", async () => {
    const { options, document, sync, scene } = fixture();
    const parent = createActor("hidden-parent", "Hidden Parent", {
      visible: false,
    });
    document.actors.push(parent);
    document.actors[0].parentId = parent.id;
    document.actors[1].visible = false;
    document.actors[2].components[0].properties.enabled = false;
    // MeshComponent has no authored Enabled/Visible switch: these unrelated fields must not hide geometry.
    document.actors[0].components[0].properties.enabled = false;
    document.actors[0].components[0].properties.visible = false;
    sync.apply(document);
    expect(sync.meshForActor("receiver")!.isVisible).toBe(true);
    expect(
      scene.lights
        .find((light) => light instanceof PointLight && light.intensity === 4)!
        .isEnabled(),
    ).toBe(true);
    const prepared = await prepareSceneBake(options);
    expect(prepared.meshes).toHaveLength(1);
    expect(prepared.sources).toHaveLength(1);
    expect(prepared.sources[0]).toMatchObject({
      actorId: "lamp",
      mobility: "static",
    });
    document.actors[0].visible = false;
    await expect(prepareSceneBake(options)).rejects.toThrow("Static Receiver");
  });

  it("rejects unsupported sources before transport or publication instead of dropping them", async () => {
    const { options, document } = fixture();
    document.actors[0].components[0].properties.assetGuid = "model-1";
    await expect(prepareSceneBake(options)).rejects.toThrow("provenance");
    document.actors[0].components[0].properties.assetGuid = null;
    document.actors[1].components[0].properties.lightKind = "spot";
    await expect(prepareSceneBake(options)).rejects.toThrow("Point transport");
    document.actors[1].components[0].properties.lightKind = "point";
    document.actors[1].components[0].classId = "HemisphericFillLightComponent";
    await expect(prepareSceneBake(options)).rejects.toThrow("Point transport");
    document.actors[1].components[0].classId = "LightComponent";
    document.settings.environmentTextureGuid = "environment-1";
    await expect(prepareSceneBake(options)).rejects.toThrow("environment cube");
  });

  it("deinterleaves normalized integer attributes without losing raw component values", () => {
    const { scene, engine } = fixture();
    const mesh = MeshBuilder.CreateGround("packed", {}, scene);
    const raw = new Uint8Array([
      90, 1, 255, 77, 90, 2, 254, 77, 90, 3, 253, 77, 90, 4, 252, 77,
    ]);
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, raw, "custom", {
        size: 2,
        type: VertexBuffer.UNSIGNED_BYTE,
        normalized: true,
        stride: 4,
        offset: 1,
        useBytes: true,
      }),
    );
    const copied = snapshotBakeMesh(mesh).attributes.find(
      (attribute) => attribute.name === "custom",
    )!;
    expect(copied.componentType).toBe("u8");
    expect(copied.normalized).toBe(true);
    expect([...copied.data]).toEqual([1, 255, 2, 254, 3, 253, 4, 252]);
    raw.fill(0);
    expect([...copied.data]).toEqual([1, 255, 2, 254, 3, 253, 4, 252]);
  });
});
