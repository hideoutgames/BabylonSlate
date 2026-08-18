import { describe, expect, it, vi } from "vitest";
import type { SerializedComponent } from "@babylonslate/core";
import { defaultPropertiesFor } from "../panels/add-component-catalog";
import {
  componentPropertyRows,
  gameInstanceClassEntries,
  subclassClassEntries,
  type ComponentPropertyContext,
} from "./component-property-rows";

function rowsFor(
  component: SerializedComponent,
  context: Partial<ComponentPropertyContext> = {},
) {
  const update = vi.fn();
  const onPickAsset = vi.fn();
  const rows = componentPropertyRows(
    "actor-1",
    component,
    update,
    {
      sortingLayers: ["Background", "Default", "UI"],
      assetLabel: (guid) =>
        guid === "mesh-1"
          ? "Rock"
          : guid === "sprite-1"
            ? "Hero"
            : guid === "ui-1"
              ? "HUD"
              : guid === "graph-1"
                ? "Locomotion"
                : guid === "tile-1"
                  ? "Overworld"
                  : guid === "sfx-1"
                    ? "Jump"
                    : guid === "fx-1"
                      ? "Fire"
                      : undefined,
      assetType: (guid) =>
        guid === "mesh-1"
          ? "Mesh"
          : guid === "sprite-1"
            ? "Sprite"
            : guid === "ui-1"
              ? "UserInterface"
              : guid === "graph-1"
                ? "AnimationGraph"
                : guid === "tile-1"
                  ? "Tilemap"
                  : guid === "tree-1"
                    ? "BehaviourTree"
                    : guid === "bb-1"
                      ? "Blackboard"
                      : guid === "sfx-1"
                        ? "Audio"
                        : guid === "fx-1"
                          ? "ParticleSystem"
                          : undefined,
      physicsWorld: "3d",
      onPickAsset,
      ...context,
    },
  );
  return { rows, update, onPickAsset };
}

describe("componentPropertyRows", () => {
  it("exposes MeshComponent.assetGuid as an asset pick of Mesh/Model", () => {
    const { rows, onPickAsset } = rowsFor({
      id: "mesh",
      classId: "MeshComponent",
      properties: { meshKind: "box", assetGuid: "mesh-1" },
    });
    const asset = rows.find((row) => row.id.endsWith("-assetGuid"));
    expect(asset).toMatchObject({
      kind: "asset",
      value: "mesh-1",
      displayLabel: "Rock",
      displayType: "Mesh",
      visual: { assetType: "Mesh" },
    });
    expect(rows.find((row) => row.id.endsWith("-meshKind"))).toMatchObject({
      kind: "enum",
      value: "box",
    });
    if (asset?.kind === "asset") asset.onPick();
    expect(onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        property: "assetGuid",
        allowedTypes: ["Mesh", "Model"],
      }),
    );
  });

  it("uses Sprite and Tilemap pickers plus project sorting layers", () => {
    const sprite = rowsFor({
      id: "sprite",
      classId: "SpriteComponent",
      properties: { assetGuid: "sprite-1", sortingLayer: "Default", orderInLayer: 0 },
    });
    expect(
      sprite.rows.find((row) => row.id.endsWith("-assetGuid")),
    ).toMatchObject({
      kind: "asset",
      displayLabel: "Hero",
    });
    const layer = sprite.rows.find((row) => row.id.endsWith("-sortingLayer"));
    expect(layer).toMatchObject({ kind: "enum", value: "Default" });
    if (layer?.kind === "enum") {
      expect(layer.options.map((option) => option.value)).toEqual([
        "Background",
        "Default",
        "UI",
      ]);
    }

    const tilemap = rowsFor({
      id: "tiles",
      classId: "TilemapComponent",
      properties: { assetGuid: "tile-1", sortingLayer: "Background", orderInLayer: 1 },
    });
    const tileAsset = tilemap.rows.find((row) => row.id.endsWith("-assetGuid"));
    expect(tileAsset).toMatchObject({ kind: "asset", displayLabel: "Overworld" });
    if (tileAsset?.kind === "asset") tileAsset.onPick();
    expect(tilemap.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["Tilemap"] }),
    );
  });

  it("picks UserInterface and AnimationGraph assets by guid field", () => {
    const widget = rowsFor({
      id: "hud",
      classId: "WidgetComponent",
      properties: { uiAssetGuid: "ui-1", viewportLayer: false },
    });
    const ui = widget.rows.find((row) => row.id.endsWith("-uiAssetGuid"));
    expect(ui).toMatchObject({ kind: "asset", displayLabel: "HUD" });
    if (ui?.kind === "asset") ui.onPick();
    expect(widget.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["UserInterface"] }),
    );

    const graph = rowsFor({
      id: "anim",
      classId: "AnimationGraphComponent",
      properties: { graphGuid: "graph-1" },
    });
    const graphRow = graph.rows.find((row) => row.id.endsWith("-graphGuid"));
    expect(graphRow).toMatchObject({ kind: "asset", displayLabel: "Locomotion" });
    if (graphRow?.kind === "asset") graphRow.onPick();
    expect(graph.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["AnimationGraph"] }),
    );

    const tree = rowsFor({
      id: "ai",
      classId: "BehaviourTreeComponent",
      properties: { treeGuid: "tree-1", blackboardGuid: "bb-1" },
    });
    const treeRow = tree.rows.find((row) => row.id.endsWith("-treeGuid"));
    const boardRow = tree.rows.find((row) => row.id.endsWith("-blackboardGuid"));
    expect(treeRow).toMatchObject({ kind: "asset" });
    expect(boardRow).toMatchObject({ kind: "asset" });
    if (treeRow?.kind === "asset") treeRow.onPick();
    expect(tree.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["BehaviourTree"] }),
    );

    const audio = rowsFor({
      id: "speaker",
      classId: "AudioComponent",
      properties: {
        audioAssetGuid: "sfx-1",
        playOnStart: true,
        loop: false,
        volume: 0.5,
      },
    });
    const audioAsset = audio.rows.find((row) => row.id.endsWith("-audioAssetGuid"));
    expect(audioAsset).toMatchObject({
      kind: "asset",
      displayLabel: "Jump",
    });
    if (audioAsset?.kind === "asset") audioAsset.onPick();
    expect(audio.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["Audio"] }),
    );
    expect(audio.rows.find((row) => row.id.endsWith("-playOnStart"))).toMatchObject({
      kind: "boolean",
      value: true,
    });
    expect(audio.rows.find((row) => row.id.endsWith("-loop"))).toMatchObject({
      kind: "boolean",
      value: false,
    });
    expect(audio.rows.find((row) => row.id.endsWith("-volume"))).toMatchObject({
      kind: "number",
      value: 0.5,
    });

    const particles = rowsFor({
      id: "fx",
      classId: "ParticleComponent",
      properties: {
        particleSystemGuid: "fx-1",
        playOnStart: true,
        sortingLayer: "Default",
        orderInLayer: 2,
      },
    });
    const particleAsset = particles.rows.find((row) =>
      row.id.endsWith("-particleSystemGuid"),
    );
    expect(particleAsset).toMatchObject({
      kind: "asset",
      displayLabel: "Fire",
    });
    if (particleAsset?.kind === "asset") particleAsset.onPick();
    expect(particles.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["ParticleSystem"] }),
    );
    expect(
      particles.rows.find((row) => row.id.endsWith("-playOnStart")),
    ).toMatchObject({
      kind: "boolean",
      value: true,
    });
    expect(
      particles.rows.find((row) => row.id.endsWith("-sortingLayer")),
    ).toMatchObject({
      kind: "enum",
      value: "Default",
    });

    const emptySpeaker = rowsFor({
      id: "speaker-empty",
      classId: "AudioComponent",
      properties: defaultPropertiesFor("AudioComponent"),
    });
    const emptyAsset = emptySpeaker.rows.find((row) =>
      row.id.endsWith("-audioAssetGuid"),
    );
    expect(emptyAsset).toMatchObject({
      kind: "asset",
      value: null,
      placeholder: "Pick Audio — Play On Start needs an asset",
    });

    const navMesh = rowsFor({
      id: "nav",
      classId: "NavMeshComponent",
      properties: {
        cellSize: 0.2,
        tiled: false,
        supportDynamicObstacles: false,
        autoBakeOnSave: false,
        debugOverlay: true,
      },
    });
    expect(navMesh.rows.find((row) => row.id.endsWith("-cellSize"))).toMatchObject({
      kind: "number",
      value: 0.2,
    });
    expect(navMesh.rows.find((row) => row.id.endsWith("-tiled"))).toMatchObject({
      kind: "enum",
      value: "solo",
    });
    expect(
      navMesh.rows.find((row) => row.id.endsWith("-supportDynamicObstacles")),
    ).toMatchObject({ kind: "boolean", value: false });
    expect(
      navMesh.rows.find((row) => row.id.endsWith("-autoBakeOnSave")),
    ).toBeUndefined();
    expect(
      navMesh.rows.find((row) => row.id.endsWith("-debugOverlay")),
    ).toMatchObject({ kind: "boolean", value: true });

    const agent = rowsFor({
      id: "agent",
      classId: "NavAgentComponent",
      properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
    });
    expect(agent.rows.find((row) => row.id.endsWith("-radius"))).toMatchObject({
      kind: "number",
      value: 0.5,
    });

    const blocker = rowsFor({
      id: "block",
      classId: "NavMeshBlockerComponent",
      properties: { dynamic: true, kind: "cylinder", area: "cost" },
    });
    expect(blocker.rows.find((row) => row.id.endsWith("-dynamic"))).toMatchObject({
      kind: "boolean",
      value: true,
    });
    expect(blocker.rows.find((row) => row.id.endsWith("-kind"))).toMatchObject({
      kind: "enum",
      value: "cylinder",
    });
    expect(blocker.rows.find((row) => row.id.endsWith("-area"))).toMatchObject({
      kind: "enum",
      value: "cost",
    });
    if (boardRow?.kind === "asset") boardRow.onPick();
    expect(tree.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTypes: ["Blackboard"] }),
    );
  });

  it("exposes RigidBody motionType as an enum and Light color as a color row", () => {
    const body = rowsFor({
      id: "rb",
      classId: "RigidBodyComponent",
      properties: {
        motionType: "dynamic",
        mass: 1,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 1,
      },
    });
    const motion = body.rows.find((row) => row.id.endsWith("-motionType"));
    expect(motion).toMatchObject({ kind: "enum", value: "dynamic" });
    if (motion?.kind === "enum") {
      expect(motion.options.map((option) => option.value)).toEqual([
        "static",
        "kinematic",
        "dynamic",
      ]);
    }

    const light = rowsFor({
      id: "light",
      classId: "LightComponent",
      properties: { intensity: 1, color: [1, 0, 0] },
    });
    expect(light.rows.find((row) => row.id.endsWith("-color"))).toMatchObject({
      kind: "color",
      value: [1, 0, 0],
    });
    expect(light.rows.find((row) => row.id.endsWith("-intensity"))).toMatchObject({
      kind: "slider",
      value: 1,
      min: 0,
      max: 16,
    });
    expect(light.rows.find((row) => row.id.endsWith("-range"))).toMatchObject({
      kind: "number",
      value: 10,
      min: 0,
    });
    expect(light.rows.find((row) => row.id.endsWith("-lightKind"))).toMatchObject({
      kind: "enum",
      value: "point",
    });
    expect(light.rows.find((row) => row.id.endsWith("-outerAngle"))).toBeUndefined();
    expect(light.rows.find((row) => row.id.endsWith("-enabled"))).toMatchObject({
      kind: "boolean",
      value: true,
    });
    expect(light.rows.find((row) => row.id.endsWith("-castShadows"))).toMatchObject({
      kind: "boolean",
      value: false,
    });

    const skybox = rowsFor(
      {
        id: "sky",
        classId: "SkyboxComponent",
        properties: {
          size: 1000,
          faces: {
            px: "tex-right",
            py: null,
            pz: null,
            nx: null,
            ny: null,
            nz: null,
          },
        },
      },
      {
        assetLabel: (guid) => (guid === "tex-right" ? "Right" : undefined),
        assetType: (guid) => (guid === "tex-right" ? "Texture" : undefined),
      },
    );
    expect(skybox.rows.find((row) => row.id.endsWith("-size"))).toMatchObject({
      kind: "slider",
      label: "Size",
      value: 1000,
    });
    const px = skybox.rows.find((row) => row.id.endsWith("-faces.px"));
    expect(px).toMatchObject({
      kind: "asset",
      label: "Positive X",
      value: "tex-right",
      displayLabel: "Right",
      displayType: "Texture",
    });
    expect(skybox.rows.find((row) => row.id.endsWith("-faces.py"))).toMatchObject({
      kind: "asset",
      label: "Positive Y",
      value: null,
    });
    expect(skybox.rows.find((row) => row.id.endsWith("-faces.pz"))).toMatchObject({
      kind: "asset",
      label: "Positive Z",
    });
    expect(skybox.rows.find((row) => row.id.endsWith("-faces.nx"))).toMatchObject({
      kind: "asset",
      label: "Negative X",
    });
    expect(skybox.rows.find((row) => row.id.endsWith("-faces.ny"))).toMatchObject({
      kind: "asset",
      label: "Negative Y",
    });
    expect(skybox.rows.find((row) => row.id.endsWith("-faces.nz"))).toMatchObject({
      kind: "asset",
      label: "Negative Z",
    });
    expect(skybox.rows.find((row) => row.id.endsWith("-faces"))).toBeUndefined();
    if (px?.kind === "asset") px.onPick();
    expect(skybox.onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        property: "faces.px",
        allowedTypes: ["Texture"],
      }),
    );
    const gravity = body.rows.find((row) => row.id.endsWith("-gravityScale"));
    expect(gravity).toMatchObject({ kind: "slider", value: 1, min: 0, max: 10 });
  });

  it("uses sliders for camera field of view and orthographic size", () => {
    const camera = rowsFor({
      id: "cam",
      classId: "CameraComponent",
      properties: { fieldOfView: 60, orthographicSize: 5 },
    });
    expect(camera.rows.find((row) => row.id.endsWith("-fieldOfView"))).toMatchObject({
      kind: "slider",
      value: 60,
      min: 1,
      max: 179,
    });
    expect(
      camera.rows.find((row) => row.id.endsWith("-orthographicSize")),
    ).toMatchObject({
      kind: "slider",
      value: 5,
      min: 0.1,
      max: 50,
    });
    expect(
      camera.rows.find((row) => row.id.endsWith("-projectionMode")),
    ).toMatchObject({
      kind: "enum",
      value: "perspective",
    });
  });

  it("offers Attempt Possess View Target as an off-by-default camera toggle", () => {
    const camera = rowsFor({
      id: "cam",
      classId: "CameraComponent",
      properties: { fieldOfView: 60 },
    });
    expect(
      camera.rows.find((row) => row.id.endsWith("-attemptPossessViewTarget")),
    ).toMatchObject({
      kind: "boolean",
      label: "Attempt Possess View Target",
      value: false,
      defaultValue: false,
    });
    expect(camera.rows.find((row) => row.id.endsWith("-nearClip"))).toMatchObject({
      kind: "number",
      value: 0.1,
    });
    expect(camera.rows.find((row) => row.id.endsWith("-farClip"))).toMatchObject({
      kind: "number",
      value: 1000,
    });
  });

  it("shows outer angle for a spot light", () => {
    const spot = rowsFor({
      id: "spot",
      classId: "LightComponent",
      properties: { lightKind: "spot", range: 12, outerAngle: 45, intensity: 1 },
    });
    expect(spot.rows.find((row) => row.id.endsWith("-outerAngle"))).toMatchObject({
      kind: "number",
      value: 45,
      min: 1,
      max: 179,
    });
    expect(spot.rows.find((row) => row.id.endsWith("-range"))).toMatchObject({
      kind: "number",
      value: 12,
    });
    expect(spot.rows.find((row) => row.id.endsWith("-innerAngle"))).toMatchObject({
      kind: "number",
      value: 30,
    });
  });

  it("hides range on a directional light", () => {
    const directional = rowsFor({
      id: "sun",
      classId: "LightComponent",
      properties: { lightKind: "directional", intensity: 1 },
    });
    expect(directional.rows.find((row) => row.id.endsWith("-range"))).toBeUndefined();
  });

  it("flattens collider shape kind and numeric extents instead of object text", () => {
    const { rows, update } = rowsFor({
      id: "col",
      classId: "ColliderComponent",
      properties: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.25, z: 0.5 } },
        friction: 0.5,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 1,
      },
    });
    expect(rows.some((row) => row.kind === "text" && row.label === "shape")).toBe(
      false,
    );
    const kind = rows.find((row) => row.id.endsWith("-shape-kind"));
    expect(kind).toMatchObject({ kind: "enum", value: "box" });
    if (kind?.kind === "enum") {
      expect(kind.options.map((option) => option.value)).toEqual([
        "box",
        "sphere",
        "capsule",
      ]);
      kind.onChange("sphere");
    }
    expect(update).toHaveBeenCalledWith(
      "shape",
      expect.objectContaining({ kind: "sphere", radius: expect.any(Number) }),
    );
    expect(rows.find((row) => row.id.endsWith("-shape-half-extents"))).toMatchObject({
      kind: "vector3",
      value: [0.5, 0.25, 0.5],
    });
    expect(rows.find((row) => row.id.endsWith("-friction"))).toMatchObject({
      kind: "slider",
      value: 0.5,
      min: 0,
      max: 1,
    });
    expect(rows.find((row) => row.id.endsWith("-layer"))).toMatchObject({
      kind: "flags",
      value: 1,
      bitCount: 32,
    });
    expect(rows.find((row) => row.id.endsWith("-mask"))).toMatchObject({
      kind: "flags",
      value: 1,
    });
  });

  it("skips polygon and mesh point-cloud JSON for collider shapes", () => {
    const mesh = rowsFor({
      id: "col",
      classId: "ColliderComponent",
      properties: {
        shape: { kind: "mesh", vertices: [{ x: 0, y: 0, z: 0 }], indices: [0] },
        friction: 0.5,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 1,
      },
    });
    expect(mesh.rows.find((row) => row.id.endsWith("-shape-kind"))).toMatchObject({
      kind: "enum",
      value: "mesh",
    });
    expect(mesh.rows.some((row) => row.kind === "text")).toBe(false);

    const polygon = rowsFor(
      {
        id: "col",
        classId: "ColliderComponent",
        properties: {
          shape: { kind: "polygon", points: [{ x: 0, y: 0 }] },
          friction: 0.5,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
      },
      { physicsWorld: "2d" },
    );
    const kind = polygon.rows.find((row) => row.id.endsWith("-shape-kind"));
    expect(kind).toMatchObject({ kind: "enum", value: "polygon" });
    if (kind?.kind === "enum") {
      expect(kind.options.map((option) => option.value)).toContain("box2d");
      expect(kind.options.map((option) => option.value)).toContain("circle");
    }
  });
});

describe("gameInstanceClassEntries", () => {
  it("lists GameInstance and project classes in that lineage", () => {
    const entries = gameInstanceClassEntries([
      {
        header: { type: "Class", name: "MyGame", parentClass: "GameInstance" },
      },
      { header: { type: "Class", name: "Hero", parentClass: "Actor" } },
      { header: { type: "Mesh", name: "Rock" } },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["GameInstance", "MyGame"]);
  });

  it("omits the default Actor class asset from the Game Instance picker", () => {
    const entries = gameInstanceClassEntries([
      {
        path: "assets/main.class.babasset",
        header: { type: "Class", name: "main.class", parentClass: "Actor" },
      },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["GameInstance"]);
  });
});

describe("subclassClassEntries", () => {
  it("lists the constraint class and subclasses for a classRef pin", () => {
    const actorEntries = subclassClassEntries("Actor", [
      { header: { type: "Class", name: "Hero", parentClass: "Actor" } },
      {
        header: { type: "Class", name: "MyGame", parentClass: "GameInstance" },
      },
    ]);
    expect(actorEntries.map((entry) => entry.id)).toContain("Actor");
    expect(actorEntries.map((entry) => entry.id)).toContain("Hero");
    expect(actorEntries.map((entry) => entry.id)).not.toContain("MyGame");
    const componentEntries = subclassClassEntries("ActorComponent", []);
    expect(componentEntries.map((entry) => entry.id)).toContain("ActorComponent");
    expect(componentEntries.map((entry) => entry.id)).toContain("MeshComponent");
    expect(componentEntries.map((entry) => entry.id)).not.toContain("Actor");
  });

  it("hides editor graph classes from a runtime class picker", () => {
    const entries = subclassClassEntries("BObject", [
      { header: { type: "Class", name: "Hero", parentClass: "Actor" } },
      { header: { type: "Class", name: "LevelTools", parentClass: "EditorUtilityObject" } },
      {
        header: {
          type: "Class",
          name: "EditorMath",
          parentClass: "EditorFunctionLibrary",
        },
      },
      { header: { type: "Class", name: "MathLib", parentClass: "FunctionLibrary" } },
    ]);
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("Hero");
    expect(ids).toContain("FunctionLibrary");
    expect(ids).toContain("MathLib");
    expect(ids).not.toContain("EditorUtilityObject");
    expect(ids).not.toContain("LevelTools");
    expect(ids).not.toContain("EditorFunctionLibrary");
    expect(ids).not.toContain("EditorMath");
  });

  it("includes editor graph classes when the host is an editor graph", () => {
    const entries = subclassClassEntries(
      "BObject",
      [
        {
          header: {
            type: "Class",
            name: "LevelTools",
            parentClass: "EditorUtilityObject",
          },
        },
        {
          header: {
            type: "Class",
            name: "EditorMath",
            parentClass: "EditorFunctionLibrary",
          },
        },
      ],
      { editorGraph: true },
    );
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("EditorUtilityObject");
    expect(ids).toContain("LevelTools");
    expect(ids).toContain("EditorFunctionLibrary");
    expect(ids).toContain("EditorMath");
  });

  it("uses the compile class id for a Class asset named main.class", () => {
    const assets = [
      {
        path: "assets/main.class.babasset",
        header: { type: "Class", name: "main.class", parentClass: "Actor" },
      },
    ];
    const entries = subclassClassEntries("BObject", assets);
    const main = entries.find((entry) => entry.id === "main");
    expect(main).toMatchObject({ id: "main", name: "main", group: "Project" });
    expect(entries.map((entry) => entry.id)).not.toContain("main.class");
  });

  it("lists project UserInterface classes on an Apply classRef pin", () => {
    const entries = subclassClassEntries("UserInterface", [
      {
        header: {
          type: "UserInterface",
          name: "HUD",
          guid: "hud-guid",
        },
      },
      {
        header: { type: "Class", name: "Hero", parentClass: "Actor" },
      },
    ]);
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("UserInterface");
    expect(ids).toContain("UserInterface:hud-guid");
    expect(ids).not.toContain("Hero");
    expect(entries.find((entry) => entry.id === "UserInterface:hud-guid")).toMatchObject({
      id: "UserInterface:hud-guid",
      name: "HUD",
      group: "Project",
    });
  });
});
