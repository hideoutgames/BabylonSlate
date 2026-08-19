import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  DEFAULT_RENDER_PROJECT_SETTINGS,
} from "@babylonslate/core";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import {
  createDefaultBehaviourTree,
  createDefaultBlackboard,
} from "@babylonslate/behaviour-tree";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  createDefaultSpriteAnimationPayload,
} from "@babylonslate/assets";
import { exportGame, navmeshExportGuid } from "@babylonslate/exporter";
import { resolveAudioPlayback } from "@babylonslate/assets";
import { loadGameFromFiles, guiTextureBytesFromGame } from "./artifact";
import {
  packedBootControls,
  packedContentFromGame,
  packedPlayControls,
  packedUserInterfaceControl,
} from "./hydrate";

const encoder = new TextEncoder();

function pngIhdr(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("packedContentFromGame", () => {
  it("hydrates sprite, tilemap, and navmesh payloads from the packed game", async () => {
    const scene = {
      ...createDefaultScene(),
      name: "Arena",
    };
    const sprite = {
      textureGuid: "tex-1",
      pixelsPerUnit: 100,
      frames: [
        {
          name: "idle",
          u: 0,
          v: 0,
          uSize: 1,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
        },
      ],
      clips: [{ name: "Idle", frames: ["idle"] }],
    };
    const tilemap = {
      tilesetGuid: "tileset-1",
      tileWidth: 16,
      tileHeight: 16,
      chunkSize: 32,
      layers: [],
    };
    const tileset = {
      textureGuid: "tex-1",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      margin: 0,
      spacing: 0,
      tiles: [],
    };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      pixelsPerUnit: 50,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(scene)),
        },
        {
          guid: "sprite-1",
          type: "Sprite",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(sprite)),
        },
        {
          guid: "tex-walk",
          type: "Texture",
          sceneGuid: "scene-1",
          bytes: pngIhdr(200, 100),
        },
        {
          guid: "walk-anim",
          type: "SpriteAnimation",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              ...createDefaultSpriteAnimationPayload(),
              frames: [
                {
                  textureGuid: "tex-walk",
                  durationMs: 100,
                  pivot: { x: 0.5, y: 0.5 },
                  collision: { x: 0, y: 0, width: 1, height: 1 },
                },
              ],
            }),
          ),
        },
        {
          guid: "tilemap-1",
          type: "Tilemap",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(tilemap)),
        },
        {
          guid: "tileset-1",
          type: "Tileset",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(tileset)),
        },
        {
          guid: navmeshExportGuid("scene-1"),
          type: "NavMesh",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([4, 5, 6]),
        },
        {
          guid: "anim-1",
          type: "AnimationGraph",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultAnimGraph("Hero"))),
        },
        {
          guid: "bt-1",
          type: "BehaviourTree",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultBehaviourTree("AI"))),
        },
        {
          guid: "bb-1",
          type: "Blackboard",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultBlackboard("Keys"))),
        },
        {
          guid: navmeshExportGuid("scene-2"),
          type: "NavMesh",
          sceneGuid: "scene-2",
          bytes: new Uint8Array([7, 8]),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    const content = packedContentFromGame(game);
    expect(content.spritePayloads.get("sprite-1")?.textureGuid).toBe("tex-1");
    expect(content.spriteAnimationPayloads.get("walk-anim")?.frames[0]).toMatchObject({
      textureGuid: "tex-walk",
      width: 200,
      height: 100,
    });
    expect(content.tilemapPayloads.get("tilemap-1")?.tilesetGuid).toBe("tileset-1");
    expect(content.tilesetPayloads.get("tileset-1")?.textureGuid).toBe("tex-1");
    expect(content.navmeshBytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(content.navmeshByScene.get("scene-2")).toEqual(new Uint8Array([7, 8]));
    expect(content.animGraphs.some((entry) => entry.guid === "anim-1")).toBe(true);
    expect(content.behaviourTrees.some((entry) => entry.guid === "bt-1")).toBe(true);
    expect(content.blackboards.some((entry) => entry.guid === "bb-1")).toBe(true);
    expect(content.pixelsPerUnit).toBe(50);
    expect(content.pixelPerfect).toBe(false);
    const controls = packedPlayControls(content);
    expect(controls.some((entry) => entry.type === "loadSprites")).toBe(true);
    expect(controls.some((entry) => entry.type === "loadTilemaps")).toBe(true);
    expect(controls.some((entry) => entry.type === "loadNavMesh")).toBe(true);
    expect(controls.some((entry) => entry.type === "loadAnimGraphs")).toBe(true);
    expect(controls.some((entry) => entry.type === "loadBehaviourTrees")).toBe(true);
  });

  it("resolves packed Animation Graph clips from Animation assets and maps clip guids", async () => {
    const graph = createDefaultAnimGraph("Hero");
    graph.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-idle-anim",
      clipName: "",
      durationMs: 1000,
    };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hero-idle-anim",
          type: "Animation",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              clipName: "Idle",
              modelGuid: "hero-model",
              skeletonGuid: "hero-skel",
              durationMs: 1800,
            }),
          ),
        },
        {
          guid: "anim-1",
          type: "AnimationGraph",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(graph)),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const content = packedContentFromGame(await loadGameFromFiles(packed.value.files));
    expect(content.animGraphs.find((entry) => entry.guid === "anim-1")?.document).toMatchObject({
      clips: [
        {
          assetGuid: "hero-idle-anim",
          clipName: "Idle",
          durationMs: 1800,
        },
      ],
    });
    expect(content.modelClipAnimationGuids.get("hero-model")?.get("Idle")).toBe(
      "hero-idle-anim",
    );
  });

  it("includes BT Play Animation clips in the packed worker clip catalog", async () => {
    const tree = createDefaultBehaviourTree("Guard");
    const task = tree.nodes.find((node) => node.kind === "task");
    expect(task).toBeTruthy();
    task!.classId = "bt.task.playAnimation";
    task!.properties = {
      clipKind: "sprite",
      clipAssetGuid: "idle-1",
    };
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0]!.durationMs = 200;
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              ...createDefaultScene(),
              actors: [
                createActor("guard", "Guard", {
                  components: [
                    {
                      id: "bt-1",
                      classId: "BehaviourTreeComponent",
                      properties: { treeGuid: "tree-1" },
                    },
                  ],
                }),
              ],
            }),
          ),
        },
        {
          guid: "tree-1",
          type: "BehaviourTree",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(tree)),
        },
        {
          guid: "idle-1",
          type: "SpriteAnimation",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(animation)),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const content = packedContentFromGame(await loadGameFromFiles(packed.value.files));
    expect(content.spriteAnimationPayloads.has("idle-1")).toBe(true);
    expect(content.animClipCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          guid: "idle-1",
          type: "SpriteAnimation",
          durationMs: expect.any(Number),
        }),
      ]),
    );
    expect(content.animClipCatalog.find((entry) => entry.guid === "idle-1")?.durationMs).toBeGreaterThan(0);
  });

  it("hydrates Material and Material Function documents from the packed game", async () => {
    const surface = createDefaultMaterialDocument("Rock");
    const postProcess = createDefaultMaterialDocument("Bloom", "postProcess");
    const fn = createDefaultMaterialFunctionDocument("Tint");
    const mesh = createMeshComponent("mesh-1", "box");
    mesh.properties.materialGuid = "mat-rock";
    const scene = {
      ...createDefaultScene(),
      name: "Arena",
      settings: {
        ...createDefaultScene().settings,
        postProcessStack: [{ materialGuid: "mat-bloom", enabled: true }],
      },
      actors: [
        createActor("hero", "Hero", {
          components: [mesh],
        }),
      ],
    };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(scene)),
        },
        {
          guid: "mat-rock",
          type: "Material",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(surface)),
        },
        {
          guid: "mat-bloom",
          type: "Material",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(postProcess)),
        },
        {
          guid: "fn-tint",
          type: "MaterialFunction",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(fn)),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    const content = packedContentFromGame(game);
    expect(content.materialDocuments.get("mat-rock")?.name).toBe("Rock");
    expect(content.materialDocuments.get("mat-bloom")?.domain).toBe("postProcess");
    expect(content.materialFunctions.get("fn-tint")?.name).toBe("Tint");
    expect(content.postProcessStack.map((entry) => entry.materialGuid)).toEqual([
      "mat-bloom",
    ]);
  });

  it("hydrates packed Particle Emitter and Particle System payloads", async () => {
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "em-1",
          type: "ParticleEmitter",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              ...createDefaultParticleEmitterPayload(),
              textureGuid: "tex-1",
              capacity: 64,
            }),
          ),
        },
        {
          guid: "sys-1",
          type: "ParticleSystem",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              ...createDefaultParticleSystemPayload(),
              emitterGuids: ["em-1"],
            }),
          ),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    const content = packedContentFromGame(game);
    expect(content.particleLibrary.emitters.get("em-1")?.capacity).toBe(64);
    expect(content.particleLibrary.emitters.get("em-1")?.textureGuid).toBe(
      "tex-1",
    );
    expect(content.particleLibrary.systems.get("sys-1")?.emitterGuids).toEqual([
      "em-1",
    ]);
  });

  it("hydrates Audio mixer, channel, attenuation, and packed source", async () => {
    const { encodePackedAudioAsset } = await import("@babylonslate/assets");
    const packedAudio = encodePackedAudioAsset(
      { volume: 0.5, audioChannelGuid: "sfx", soundAttenuationGuid: "near" },
      new Uint8Array([1, 2, 3, 4]),
    );
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      audioMixerGuid: "mixer-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "mixer-1",
          type: "AudioMixer",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              globalVolume: 1,
              channels: [{ channelGuid: "sfx", volume: 1 }],
            }),
          ),
        },
        {
          guid: "sfx",
          type: "AudioChannel",
          sceneGuid: "scene-1",
          bytes: encoder.encode(
            JSON.stringify({
              parentChannelGuid: null,
              effects: [{ kind: "environmentReverb", enabled: false }],
            }),
          ),
        },
        {
          guid: "near",
          type: "SoundAttenuation",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify({ innerRadius: 2, maxRadius: 20 })),
        },
        {
          guid: "jump",
          type: "Audio",
          sceneGuid: "scene-1",
          bytes: packedAudio,
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    expect(game.manifest.audioMixerGuid).toBe("mixer-1");
    expect(game.audioBytes.get("jump")).toEqual(new Uint8Array([1, 2, 3, 4]));
    const content = packedContentFromGame(game);
    expect(content.audioLibrary.mixerGuid).toBe("mixer-1");
    expect(content.audioLibrary.audio.get("jump")?.volume).toBe(0.5);
    expect(content.audioLibrary.channels.has("sfx")).toBe(true);
    expect(content.audioLibrary.attenuations.get("near")?.innerRadius).toBe(2);
    expect(
      resolveAudioPlayback({
        audio: content.audioLibrary.audio.get("jump")!,
        playCallVolume: 0.5,
        mixer: content.audioLibrary.mixers.get("mixer-1") ?? null,
        channels: content.audioLibrary.channels,
      }).gain,
    ).toBe(0.25);
  });

  it("hydrates every packed Audio clip onto guid:chunk keys", async () => {
    const { audioClipCacheKey, encodePackedAudioAsset } = await import(
      "@babylonslate/assets"
    );
    const packedAudio = encodePackedAudioAsset(
      {
        clips: [
          { chunkId: "source", name: "a", weight: 1 },
          { chunkId: "source:2", name: "b", weight: 1 },
        ],
      },
      [new Uint8Array([1, 2, 3]), new Uint8Array([9, 8])],
    );
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "jump",
          type: "Audio",
          sceneGuid: "scene-1",
          bytes: packedAudio,
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    expect(game.audioBytes.get("jump")).toEqual(new Uint8Array([1, 2, 3]));
    expect(game.audioBytes.get(audioClipCacheKey("jump", "source"))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(game.audioBytes.get(audioClipCacheKey("jump", "source:2"))).toEqual(
      new Uint8Array([9, 8]),
    );
    expect(packedContentFromGame(game).audioLibrary.audio.get("jump")?.clips).toEqual(
      [
        { chunkId: "source", name: "a", weight: 1 },
        { chunkId: "source:2", name: "b", weight: 1 },
      ],
    );
  });

  it("hydrates a packed audioReverb sidecar for the startup scene", async () => {
    const { audioReverbExportGuid } = await import("@babylonslate/exporter");
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: audioReverbExportGuid("scene-1"),
          type: "AudioReverb",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([4, 5, 6]),
        },
        {
          guid: audioReverbExportGuid("scene-2"),
          type: "AudioReverb",
          sceneGuid: "scene-2",
          bytes: new Uint8Array([7, 8]),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    expect(game.audioReverbBytes.get("scene-1")).toEqual(new Uint8Array([4, 5, 6]));
    const content = packedContentFromGame(game);
    expect(content.audioReverbBytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(content.audioReverbByScene.get("scene-2")).toEqual(new Uint8Array([7, 8]));
  });

  it("hydrates UserInterface documents and emits loadUserInterfaces before scripts", async () => {
    const scene = { ...createDefaultScene(), name: "Arena" };
    const hud = {
      name: "HUD",
      rootId: "canvas",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", name: "Canvas", children: ["play-btn"] },
        "play-btn": { id: "play-btn", kind: "Button", name: "Play" },
      },
    };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [
        {
          assetGuid: "host",
          classId: "HudHost",
          source: "export function onBeginPlay() {}\n",
          anchors: [],
          entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
        },
        {
          assetGuid: "hud-1",
          classId: "UserInterface:hud-1",
          source: "export function onBeginPlay() {}\n",
          anchors: [],
          entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
          parentClassId: "UserInterface",
        },
      ],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(scene)),
        },
        {
          guid: "hud-1",
          type: "UserInterface",
          sceneGuid: "scene-1",
          name: "HUD",
          bytes: encoder.encode(JSON.stringify(hud)),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    const content = packedContentFromGame(game);
    expect(content.userInterfaces.get("hud-1")?.widgets["play-btn"]?.kind).toBe("Button");
    const uiControl = packedUserInterfaceControl(content);
    expect(uiControl).toEqual({
      type: "loadUserInterfaces",
      documents: [
        {
          guid: "hud-1",
          widgets: expect.arrayContaining([
            { id: "canvas", kind: "Canvas", name: "Canvas" },
            { id: "play-btn", kind: "Button", name: "Play" },
          ]),
        },
      ],
    });
    expect(packedPlayControls(content).some((entry) => entry.type === "loadUserInterfaces")).toBe(
      false,
    );
    const boot = packedBootControls(content, game.scripts, [
      { classId: "HudHost" },
      { classId: "UserInterface:hud-1" },
    ]);
    expect(boot.map((entry) => entry.type)).toEqual([
      "loadUserInterfaces",
      "loadScripts",
      "play",
    ]);
    const scripts = boot.find((entry) => entry.type === "loadScripts");
    expect(scripts && scripts.type === "loadScripts" ? scripts.spawn : undefined).toEqual([
      { classId: "HudHost" },
    ]);
  });

  it("maps UiImage sidecar bytes onto the original texture guid for GUI", async () => {
    const scene = { ...createDefaultScene(), name: "Arena" };
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const pixels = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: encoder.encode(JSON.stringify(scene)),
        },
        {
          guid: "tex-1",
          type: "Texture",
          sceneGuid: "scene-1",
          bytes: ktx2,
        },
        {
          guid: "uiimage:tex-1",
          type: "UiImage",
          sceneGuid: "scene-1",
          bytes: pixels,
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    expect(game.textureBytes.get("tex-1")).toEqual(ktx2);
    expect(game.guiImageBytes.get("tex-1")).toEqual(pixels);
    expect(guiTextureBytesFromGame(game).get("tex-1")).toEqual(pixels);
  });
});
