import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneLayer,
  createDefaultSceneSettings,
  createMeshComponent,
  createText3DComponent,
  type SerializedActor,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function sceneOf(actors: SerializedActor[]): SerializedScene {
  return {
    name: "Test",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors,
  };
}

function script(source: string, extra?: Partial<CompiledScript>): CompiledScript {
  return {
    assetGuid: "hero-script",
    classId: "Hero",
    parentClassId: "Actor",
    source,
    anchors: [],
    entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
    ...extra,
  };
}

describe("component script API", () => {
  it("Set Text updates the component text, refreshes the mesh, and fires On Text Changed", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      playScene: {
        name: "Label",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("label", "Label", {
            classId: "Hero",
            components: [createText3DComponent("text-1")],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    const script: CompiledScript = {
      assetGuid: "hero-script",
      classId: "Hero",
      parentClassId: "Actor",
      source: [
        "export function onBeginPlay(ctx) {",
        '  const c = ctx.getComponentById(ctx.self, "text-1");',
        '  ctx.callComponentFunction(c, "setText", { text: "Hi" });',
        "}",
        "export function onTextChanged(ctx) {",
        '  ctx.log("log", "Changed", String(ctx.args.text ?? ""));',
        "}",
      ].join("\n"),
      anchors: [],
      entryPoints: [
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        {
          name: "onTextChanged",
          event: "onTextChanged",
          isAsync: false,
          componentId: "text-1",
        },
      ],
    };
    await runtime.loadScripts([script]);
    runtime.realizePlayWorld();
    const actor = runtime.getWorld().findActor("label");
    const text = actor?.components.find((c) => c.guid === "text-1");
    expect(text?.getVariable("text")).toBe("Hi");
    expect(
      commands.some(
        (command) =>
          command.type === "log" &&
          command.category === "Changed" &&
          command.message === "Hi",
      ),
    ).toBe(true);
    const assigns = commands.filter(
      (command) =>
        command.type === "assignMesh" &&
        "text3d" in command &&
        command.text3d?.text === "Hi",
    );
    expect(assigns.length).toBeGreaterThan(0);
    runtime.stop();
  });

  it("Set Light Range re-emits assignMesh with the live range", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("lamp", "Lamp", {
          classId: "Hero",
          components: [
            {
              id: "light-1",
              classId: "LightComponent",
              properties: { lightKind: "point", range: 10, intensity: 1 },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "light-1");',
          '  ctx.setVariableOn(c, "range", 25);',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    const assigns = commands.filter(
      (command) =>
        command.type === "assignMesh" && command.light?.range === 25,
    );
    expect(assigns.length).toBeGreaterThan(0);
    runtime.stop();
  });

  it("Set Camera Near Clip re-emits assignMesh with the live clip", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("rig", "Rig", {
          classId: "Hero",
          components: [
            {
              id: "cam-1",
              classId: "CameraComponent",
              properties: { projectionMode: "perspective", nearClip: 0.1 },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "cam-1");',
          '  ctx.setVariableOn(c, "nearClip", 0.5);',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    const assigns = commands.filter(
      (command) =>
        command.type === "assignMesh" && command.camera?.nearClip === 0.5,
    );
    expect(assigns.length).toBeGreaterThan(0);
    runtime.stop();
  });

  it("Set Mesh materialGuid emits assignMaterial", async () => {
    const commands: CommandMessage[] = [];
    const mesh = createMeshComponent("mesh-1", "box");
    mesh.properties.materialGuid = null;
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("prop", "Prop", {
          classId: "Hero",
          components: [mesh],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "mesh-1");',
          '  ctx.setVariableOn(c, "materialGuid", "mat-rock");',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    expect(
      commands.filter((command) => command.type === "assignMaterial"),
    ).toEqual([
      expect.objectContaining({
        type: "assignMaterial",
        materialAssetGuid: "mat-rock",
      }),
    ]);
    runtime.stop();
  });

  it("Set Sprite sortingLayer stamps sorting on assignMesh", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("sprite", "Sprite", {
          classId: "Hero",
          components: [
            {
              id: "sprite-1",
              classId: "SpriteComponent",
              properties: { sortingLayer: "Default", orderInLayer: 0 },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "sprite-1");',
          '  ctx.setVariableOn(c, "sortingLayer", "UI");',
          '  ctx.setVariableOn(c, "orderInLayer", 3);',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    const assigns = commands.filter(
      (command) =>
        command.type === "assignMesh" && command.actorGuid === "sprite",
    );
    const last = assigns.at(-1);
    expect(last).toMatchObject({
      type: "assignMesh",
      sortingLayer: "UI",
      orderInLayer: 3,
    });
    runtime.stop();
  });

  it("Set RigidBody mass updates the physics backend, not only the Map", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      playScene: sceneOf([
        createActor("hero", "Hero", {
          classId: "Hero",
          components: [
            {
              id: "rb",
              classId: "RigidBodyComponent",
              properties: {
                motionType: "dynamic",
                mass: 1,
                gravityScale: 0,
                linearDamping: 0,
              },
            },
            {
              id: "col",
              classId: "ColliderComponent",
              properties: {
                shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
              },
            },
          ],
        }),
      ]),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onTick(ctx) {",
          "  if (ctx.tickIndex !== 1) return;",
          '  const rb = ctx.getComponentById(ctx.self, "rb");',
          '  ctx.setVariableOn(rb, "mass", 10);',
          "  ctx.addImpulse(ctx.self, { x: 10, y: 0, z: 0 }, 1);",
          "}",
        ].join("\n"),
        {
          entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
        },
      ),
    ]);
    runtime.realizePlayWorld();
    runtime.start();
    runtime.tick();
    runtime.tick();
    expect(runtime.getWorld().findActor("hero")?.transform.position.x).toBeCloseTo(
      1 / 60,
      5,
    );
    runtime.stop();
  });

  it("Set Collider isTrigger updates the live backend", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      playScene: sceneOf([
        createActor("sensor", "Sensor", {
          classId: "Hero",
          components: [
            {
              id: "rb",
              classId: "RigidBodyComponent",
              properties: { motionType: "kinematic", mass: 1, gravityScale: 0 },
            },
            {
              id: "col-sensor",
              classId: "ColliderComponent",
              properties: {
                shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
                isTrigger: false,
              },
            },
          ],
        }),
        createActor("other", "Other", {
          transform: {
            position: [0.25, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: "rb-b",
              classId: "RigidBodyComponent",
              properties: { motionType: "kinematic", mass: 1, gravityScale: 0 },
            },
            {
              id: "col-b",
              classId: "ColliderComponent",
              properties: {
                shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
              },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onTick(ctx) {",
          "  if (ctx.tickIndex !== 1) return;",
          '  const col = ctx.getComponentById(ctx.self, "col-sensor");',
          '  ctx.setVariableOn(col, "isTrigger", true);',
          "}",
          "export function onBeginOverlap(ctx) {",
          '  ctx.log("log", "Overlap", "yes");',
          "}",
        ].join("\n"),
        {
          entryPoints: [
            { name: "onTick", event: "onTick", isAsync: false },
            {
              name: "onBeginOverlap",
              event: "onBeginOverlap",
              isAsync: false,
              componentId: "col-sensor",
            },
          ],
        },
      ),
    ]);
    runtime.realizePlayWorld();
    runtime.start();
    runtime.tick();
    expect(
      commands.some(
        (command) => command.type === "log" && command.category === "Overlap",
      ),
    ).toBe(false);
    runtime.tick();
    expect(
      commands.some(
        (command) => command.type === "log" && command.category === "Overlap",
      ),
    ).toBe(true);
    runtime.stop();
  });

  it("Set 2DAnchor offset moves the overlay actor", async () => {
    const hud: SerializedSceneLayer = {
      ...createDefaultSceneLayer(),
      name: "HUD",
      actors: [
        createActor("badge", "Badge", {
          classId: "Hero",
          components: [
            {
              id: "anchor",
              classId: "2DAnchorComponent",
              properties: { anchor: "topLeft", offsetX: 1, offsetY: -0.5 },
            },
          ],
        }),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: sceneOf([createActor("hero", "Hero")]),
      sceneLayerLibrary: { hud },
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "anchor");',
          '  ctx.setVariableOn(c, "offsetX", 3);',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    runtime.createSceneLayer("hud", 0);
    const actor = runtime.getWorld().findActor("badge");
    // normalizeSceneLayer bakes offset 1 into (-7, 4) and zeros offsets.
    // Set offsetX 3 must re-apply; a store-only write would leave x at -7.
    expect(actor?.transform.position.x).toBe(-4);
    expect(actor?.transform.position.y).toBe(4);
    runtime.stop();
  });

  it("Particle Play stamps componentId on setParticlePlaying", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("fx", "Sparks", {
          classId: "Hero",
          components: [
            {
              id: "particle-1",
              classId: "ParticleComponent",
              properties: { particleSystemGuid: "sys-1", playOnStart: false },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "particle-1");',
          '  ctx.callComponentFunction(c, "playParticles", {});',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    expect(
      commands.filter((command) => command.type === "setParticlePlaying"),
    ).toEqual([
      {
        type: "setParticlePlaying",
        actorGuid: "fx",
        componentId: "particle-1",
        playing: true,
      },
    ]);
    runtime.stop();
  });

  it("Set Particle System re-emits assignParticle with guid and sorting", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("fx", "Sparks", {
          classId: "Hero",
          components: [
            {
              id: "particle-1",
              classId: "ParticleComponent",
              properties: {
                particleSystemGuid: "sys-1",
                playOnStart: false,
                sortingLayer: "Default",
                orderInLayer: 0,
              },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "particle-1");',
          '  ctx.setVariableOn(c, "particleSystemGuid", "sys-2");',
          '  ctx.setVariableOn(c, "sortingLayer", "Foreground");',
          '  ctx.setVariableOn(c, "orderInLayer", 4);',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    const assigns = commands.filter(
      (command) =>
        command.type === "assignParticle" &&
        command.particleSystemGuid === "sys-2",
    );
    expect(assigns.at(-1)).toMatchObject({
      type: "assignParticle",
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-2",
      sortingLayer: "Foreground",
      orderInLayer: 4,
    });
    runtime.stop();
  });

  it("Set Audio Volume emits setVoiceGain for the live voice", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("speaker", "Speaker", {
          classId: "Hero",
          components: [
            {
              id: "audio-1",
              classId: "AudioComponent",
              properties: {
                audioAssetGuid: "jump",
                playOnStart: true,
                volume: 1,
              },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "audio-1");',
          '  ctx.setVariableOn(c, "volume", 0.25);',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    expect(
      commands.filter((command) => command.type === "setVoiceGain"),
    ).toEqual([
      { type: "setVoiceGain", voiceId: "audio-1", volume: 0.25 },
    ]);
    runtime.stop();
  });

  it("Possess on a CameraComponent emits possessCamera for the owner", async () => {
    const commands: CommandMessage[] = [];
    const settings = createDefaultSceneSettings();
    settings.mainCameraActorId = "rig";
    settings.mainCameraComponentId = "cam-1";
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Cam",
        viewportMode: "3d",
        settings,
        folders: [],
        actors: [
          createActor("rig", "Rig", {
            classId: "Hero",
            components: [
              {
                id: "cam-1",
                classId: "CameraComponent",
                properties: { projectionMode: "perspective" },
              },
            ],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "cam-1");',
          '  ctx.callComponentFunction(c, "possessCamera", {});',
          "}",
        ].join("\n"),
      ),
    ]);
    runtime.realizePlayWorld();
    expect(
      commands.some((command) => command.type === "possessCamera"),
    ).toBe(true);
    runtime.stop();
  });

  it("Add Impulse on a RigidBodyComponent moves the actor", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      playScene: sceneOf([
        createActor("hero", "Hero", {
          classId: "Hero",
          components: [
            {
              id: "rb",
              classId: "RigidBodyComponent",
              properties: {
                motionType: "dynamic",
                mass: 1,
                gravityScale: 0,
                linearDamping: 0,
              },
            },
            {
              id: "col",
              classId: "ColliderComponent",
              properties: {
                shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
              },
            },
          ],
        }),
      ]),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onTick(ctx) {",
          "  if (ctx.tickIndex !== 1) return;",
          '  const rb = ctx.getComponentById(ctx.self, "rb");',
          '  ctx.callComponentFunction(rb, "addImpulse", {',
          "    impulse: { x: 1, y: 0, z: 0 },",
          "    strength: 1,",
          "  });",
          "}",
        ].join("\n"),
        {
          entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
        },
      ),
    ]);
    runtime.realizePlayWorld();
    runtime.start();
    runtime.tick();
    runtime.tick();
    expect(runtime.getWorld().findActor("hero")?.transform.position.x).toBeCloseTo(
      1 / 60,
      5,
    );
    runtime.stop();
  });

  it("audioVoiceEnded fires On Audio Finished on the matching AudioComponent", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("speaker", "Speaker", {
          classId: "Hero",
          components: [
            {
              id: "audio-1",
              classId: "AudioComponent",
              properties: { audioAssetGuid: "jump", playOnStart: false },
            },
          ],
        }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      script(
        [
          "export function onAudioFinished(ctx) {",
          '  ctx.log("log", "Finished", String(ctx.self?.guid ?? ""));',
          "}",
        ].join("\n"),
        {
          entryPoints: [
            {
              name: "onAudioFinished",
              event: "onAudioFinished",
              isAsync: false,
              componentId: "audio-1",
            },
          ],
        },
      ),
    ]);
    runtime.realizePlayWorld();
    runtime.applyAudioVoiceEnded({
      type: "audioVoiceEnded",
      voiceId: "audio-1",
    });
    expect(
      commands.some(
        (command) =>
          command.type === "log" &&
          command.category === "Finished" &&
          command.message === "speaker",
      ),
    ).toBe(true);
    runtime.stop();
  });
});
