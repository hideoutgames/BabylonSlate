import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  userInterfaceClassId,
  USER_INTERFACE_ENGINE_CLASS_ID,
} from "@babylonslate/core";
import {
  applyUiRuntimeControl,
  createInProcessRuntime,
} from "@babylonslate/runtime";
import { RecordingUiHost } from "@babylonslate/render";
import {
  createDefaultUserInterface,
  createWidget,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { applyPlayerUiCommand, createPlayerUiHost } from "./player-ui-host";
import { playerSpawnListForScripts } from "./spawn-list";

const HUD_GUID = "hud-1";
const HUD_CLASS_ID = userInterfaceClassId(HUD_GUID);

function hudDocument() {
  const doc = createDefaultUserInterface("HUD");
  const button = createWidget(
    "play-btn",
    "Button",
    "Play",
    pinLayout("center", "center", 160, 40),
  );
  doc.widgets[button.id] = button;
  doc.widgets[doc.rootId]!.children.push(button.id);
  return doc;
}

describe("player UserInterface integration", () => {
  it("does not auto-spawn UserInterface script classes", () => {
    expect(
      playerSpawnListForScripts([
        {
          classId: "HudHost",
          entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
        },
        {
          classId: HUD_CLASS_ID,
          entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
        },
        {
          classId: "NoLifecycle",
          entryPoints: [{ name: "onReady", isAsync: false }],
        },
      ]),
    ).toEqual([{ classId: "HudHost" }]);
  });

  it("mounts Apply, routes a Button click into UI logic, and unmounts on Remove", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    const recording = new RecordingUiHost();
    const uiHost = createPlayerUiHost({
      library: new Map([[HUD_GUID, hudDocument()]]),
      host: recording,
      viewport: { width: 800, height: 600 },
      onWidgetEvent: (event) => {
        applyUiRuntimeControl(runtime, event);
      },
    });
    applyUiRuntimeControl(runtime, {
      type: "loadUserInterfaces",
      documents: [
        {
          guid: HUD_GUID,
          widgets: [
            { id: "canvas", kind: "Canvas", name: "Canvas" },
            { id: "play-btn", kind: "Button", name: "Play" },
          ],
        },
      ],
    });
    await runtime.loadScripts([
      {
        assetGuid: HUD_GUID,
        classId: HUD_CLASS_ID,
        parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
        source:
          'export function onWidgetClick(ctx) { ctx.log("log", "ui", String(ctx.args.widgetId)); }\n',
        anchors: [],
        entryPoints: [
          { name: "onWidgetClick", event: "onWidgetClick", isAsync: false },
        ],
      },
      {
        assetGuid: "hud-host",
        classId: "HudHost",
        source: `export function onBeginPlay(ctx) { ctx.applyUserInterface("${HUD_GUID}"); }\n`,
        anchors: [],
        entryPoints: [
          { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        ],
      },
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    const applied = commands.find((command) => command.type === "uiApply");
    expect(applied?.type).toBe("uiApply");
    if (applied?.type !== "uiApply") return;
    applyPlayerUiCommand(uiHost, applied);
    expect(recording.controls.some((control) => control.id === "ui-1:play-btn")).toBe(
      true,
    );
    expect(
      runtime.getWorld().getActors().some((actor) => actor.classId === HUD_CLASS_ID),
    ).toBe(false);

    uiHost.handleWidgetEvent({ kind: "click", widgetId: "ui-1:play-btn" });
    expect(
      commands.some(
        (command) =>
          command.type === "log" && String(command.message).includes("play-btn"),
      ),
    ).toBe(true);

    runtime.removeUserInterface("ui-1");
    const removed = commands.find((command) => command.type === "uiRemove");
    expect(removed).toEqual({ type: "uiRemove", instanceId: "ui-1" });
    if (removed) applyPlayerUiCommand(uiHost, removed);
    expect(uiHost.instances()).toEqual([]);
    uiHost.handleWidgetEvent({ kind: "click", widgetId: "ui-1:play-btn" });
    const clickLogs = commands.filter(
      (command) =>
        command.type === "log" && String(command.message).includes("play-btn"),
    );
    expect(clickLogs).toHaveLength(1);
    runtime.stop();
  });
});
