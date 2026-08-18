import { describe, expect, it } from "vitest";
import type { CommandMessage, ControlMessage } from "./channels";

function commandType(command: CommandMessage): CommandMessage["type"] {
  return command.type;
}

function controlType(control: ControlMessage): ControlMessage["type"] {
  return control.type;
}

describe("UserInterface command and control contracts", () => {
  it("uiApply carries instanceId, classId, and assetGuid", () => {
    const command = {
      type: "uiApply",
      instanceId: "ui-1",
      classId: "UserInterface:hud-guid",
      assetGuid: "hud-guid",
    } satisfies CommandMessage;
    expect(commandType(command)).toBe("uiApply");
    expect(command).toEqual({
      type: "uiApply",
      instanceId: "ui-1",
      classId: "UserInterface:hud-guid",
      assetGuid: "hud-guid",
    });
  });

  it("uiSetVisible is instance-scoped", () => {
    const command = {
      type: "uiSetVisible",
      instanceId: "ui-1",
      widgetId: "play-btn",
      visible: false,
    } satisfies CommandMessage;
    expect(command).toEqual({
      type: "uiSetVisible",
      instanceId: "ui-1",
      widgetId: "play-btn",
      visible: false,
    });
  });

  it("loadUserInterfaces supplies slim widget metadata to the worker", () => {
    const control = {
      type: "loadUserInterfaces",
      documents: [
        {
          guid: "hud-guid",
          widgets: [
            { id: "root", kind: "Canvas", name: "Canvas" },
            { id: "play-btn", kind: "Button", name: "Play" },
          ],
        },
      ],
    } satisfies ControlMessage;
    expect(controlType(control)).toBe("loadUserInterfaces");
    expect(control.documents[0]?.widgets).toHaveLength(2);
  });

  it("uiWidgetEvent routes main-thread widget input to the owning instance", () => {
    const click = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "click",
    } satisfies ControlMessage;
    const value = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "volume",
      kind: "value",
      value: 0.4,
    } satisfies ControlMessage;
    const checked = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "mute",
      kind: "checked",
      value: true,
    } satisfies ControlMessage;
    const text = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "name",
      kind: "text",
      value: "Ada",
    } satisfies ControlMessage;
    expect(click.kind).toBe("click");
    expect(value.value).toBe(0.4);
    expect(checked.value).toBe(true);
    expect(text.value).toBe("Ada");
    const enter = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "pointerEnter",
    } satisfies ControlMessage;
    const exit = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "pointerExit",
    } satisfies ControlMessage;
    const press = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "pointerDown",
    } satisfies ControlMessage;
    const release = {
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "pointerUp",
    } satisfies ControlMessage;
    expect(enter.kind).toBe("pointerEnter");
    expect(exit.kind).toBe("pointerExit");
    expect(press.kind).toBe("pointerDown");
    expect(release.kind).toBe("pointerUp");
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

describe("Particle commands", () => {
  it("assignParticle and setParticlePlaying are CommandMessage variants", () => {
    const assign = {
      type: "assignParticle",
      slotId: 1,
      actorGuid: "fx",
      componentId: "particle-1",
      particleSystemGuid: "sys-1",
      play: true,
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
    expect(stop.playing).toBe(false);
  });
});
