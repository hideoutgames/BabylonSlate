import { describe, expect, it } from "vitest";
import type { CommandMessage, ControlMessage } from "./channels";

function commandType(command: CommandMessage): CommandMessage["type"] {
  return command.type;
}

function controlType(control: ControlMessage): ControlMessage["type"] {
  return control.type;
}

describe("assignMesh visual payloads", () => {
  it("assignMesh can carry a 3D Text payload", () => {
    const command = {
      type: "assignMesh",
      slotId: 3,
      meshAssetGuid: null,
      meshKind: "text3d",
      text3d: {
        text: "Hello",
        size: 1,
        depth: 0.1,
        color: [1, 1, 1],
        fontAssetGuid: "font-1",
      },
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("assignMesh");
    expect(command.text3d?.text).toBe("Hello");
    expect(command.text3d?.fontAssetGuid).toBe("font-1");
  });

  it("assignMesh can carry a 2D Text payload", () => {
    const command = {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: "font-1",
      meshKind: "2dtext",
      hitTest: "block",
      hasButton: true,
      text2d: {
        text: "Hi",
        size: 32,
        color: [1, 1, 1],
        fontAssetGuid: "font-1",
        renderer: "bitmap",
        outline: 0,
        outlineColor: [0, 0, 0],
        alignment: "left",
        bold: false,
        italic: false,
        underline: false,
        wrapWidth: 0,
      },
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("assignMesh");
    expect(command.text2d?.renderer).toBe("bitmap");
    expect(command.text2d?.fontAssetGuid).toBe("font-1");
  });

  it("assignMesh can carry a 2D Panel 9-slice payload", () => {
    const command = {
      type: "assignMesh",
      slotId: 5,
      meshAssetGuid: "tex-panel",
      meshKind: "2dpanel",
      overlayPanel: {
        source: "texture",
        textureGuid: "tex-panel",
        materialGuid: null,
        marginLeft: 8,
        marginRight: 8,
        marginTop: 4,
        marginBottom: 4,
        hitTest: "ignore",
      },
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("assignMesh");
    expect(command.overlayPanel?.marginLeft).toBe(8);
  });

  it("assignMesh can carry a skybox payload", () => {
    const command = {
      type: "assignMesh",
      slotId: 2,
      meshAssetGuid: null,
      meshKind: "skybox",
      skybox: {
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
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("assignMesh");
    expect(command.skybox?.faces.px).toBe("tex-right");
  });
});

describe("Play inspect contract", () => {
  it("inspect control and inspectSnapshot command round-trip a node list", () => {
    const control = { type: "inspect" } satisfies ControlMessage;
    expect(controlType(control)).toBe("inspect");
    const command = {
      type: "inspectSnapshot",
      snapshot: {
        tickIndex: 4,
        nodes: [
          {
            id: "hero",
            kind: "actor",
            label: "Hero",
            classId: "Actor",
            parentId: null,
            variables: { health: 10 },
            variableTypes: { health: "float" },
          },
        ],
      },
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("inspectSnapshot");
    expect(command.snapshot.nodes[0]?.label).toBe("Hero");
  });
});

describe("Play session commands", () => {
  it("sessionPaused reports overlay pause chrome", () => {
    const command = {
      type: "sessionPaused",
      paused: true,
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("sessionPaused");
    expect(command.paused).toBe(true);
  });

  it("setRenderQuality, setResolutionScale, and setFrameCap are CommandMessage variants", () => {
    const quality = {
      type: "setRenderQuality",
      level: "low",
    } satisfies CommandMessage;
    const scale = {
      type: "setResolutionScale",
      scale: 1.5,
    } satisfies CommandMessage;
    const cap = { type: "setFrameCap", fps: 30 } satisfies CommandMessage;
    expect(commandType(quality)).toBe("setRenderQuality");
    expect(commandType(scale)).toBe("setResolutionScale");
    expect(commandType(cap)).toBe("setFrameCap");
  });

  it("setFreeCam is a CommandMessage variant", () => {
    const command = {
      type: "setFreeCam",
      enabled: true,
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("setFreeCam");
    expect(command.enabled).toBe(true);
  });

  it("SceneLayer compositor commands are CommandMessage variants", () => {
    const created = {
      type: "sceneLayerCreate",
      layerId: "layer-1",
      assetGuid: "hud",
      zOrder: 2,
      ownerSceneGuid: "level-a",
      postProcessStack: [{ materialGuid: "bloom", enabled: true }],
    } satisfies CommandMessage;
    const removed = {
      type: "sceneLayerRemove",
      layerId: "layer-1",
    } satisfies CommandMessage;
    const cleared = { type: "sceneLayerClear" } satisfies CommandMessage;
    const stack = {
      type: "sceneLayerPostProcess",
      layerId: "layer-1",
      postProcessStack: [],
    } satisfies CommandMessage;
    expect(commandType(created)).toBe("sceneLayerCreate");
    expect(commandType(removed)).toBe("sceneLayerRemove");
    expect(commandType(cleared)).toBe("sceneLayerClear");
    expect(commandType(stack)).toBe("sceneLayerPostProcess");
  });

  it("sceneLayerPointer is a ControlMessage variant", () => {
    const control = {
      type: "sceneLayerPointer",
      layerId: "layer-1",
      actorGuid: "banner",
      event: "onClick",
      componentId: "btn-1",
    } satisfies ControlMessage;
    expect(controlType(control)).toBe("sceneLayerPointer");
  });

  it("sceneLayerResize is a ControlMessage variant", () => {
    const control = {
      type: "sceneLayerResize",
      frustumWidth: 16,
      frustumHeight: 9,
    } satisfies ControlMessage;
    expect(controlType(control)).toBe("sceneLayerResize");
  });

  it("setCursorVisible is a CommandMessage variant", () => {
    const command = {
      type: "setCursorVisible",
      visible: true,
      frameId: 1,
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("setCursorVisible");
  });

  it("visualization console commands are CommandMessage variants", () => {
    const fps = { type: "setShowFps", enabled: true } satisfies CommandMessage;
    const stat = {
      type: "setStat",
      name: "unit",
      enabled: true,
    } satisfies CommandMessage;
    const colliders = {
      type: "debugColliders",
      colliders: [
        {
          id: "c1",
          shape: "box",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          halfExtents: { x: 1, y: 1, z: 1 },
        },
      ],
    } satisfies CommandMessage;
    expect(commandType(fps)).toBe("setShowFps");
    expect(commandType(stat)).toBe("setStat");
    expect(commandType(colliders)).toBe("debugColliders");
  });
});

describe("Particle commands", () => {
  it("assignParticle and setParticlePlaying are CommandMessage variants", () => {
    const assign = {
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
      sortingLayer: "UI",
      orderInLayer: 1,
    } satisfies CommandMessage;
    const stop = {
      type: "setParticlePlaying",
      actorGuid: "fx",
      componentId: "particle-1",
      playing: false,
    } satisfies CommandMessage;
    expect(commandType(assign)).toBe("assignParticle");
    expect(commandType(stop)).toBe("setParticlePlaying");
    expect(assign.particleSystemGuid).toBe("sys-1");
    expect(assign.sortingLayer).toBe("UI");
    expect(assign.orderInLayer).toBe(1);
    expect(stop.playing).toBe(false);
  });
});
