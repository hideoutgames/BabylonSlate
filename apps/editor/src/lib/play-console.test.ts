import { describe, expect, it } from "vitest";
import { playConsoleCommands, playConsoleCompletionContext } from "./play-console";

describe("playConsoleCommands", () => {
  it("includes core commands and compiled user BDebugCommand names", () => {
    const names = playConsoleCommands([
      {
        assetGuid: "heal",
        classId: "HealCommand",
        source: "",
        anchors: [],
        entryPoints: [{ name: "onCommandRun", event: "onCommandRun", isAsync: false }],
        command: {
          name: "heal",
          description: "Heal",
          category: "game",
          parameters: [{ name: "amount", type: "float" }],
        },
      },
    ]).map((command) => command.name);
    expect(names).toContain("changescene");
    expect(names).toContain("heal");
    expect(names).toContain("showfps");
    expect(names).toContain("showaudiodebug");
  });

  it("builds scene, actor, and command completion values", () => {
    const commands = playConsoleCommands();
    const context = playConsoleCompletionContext({
      commands,
      sceneAssetGuid: "scene-1",
      scene: { name: "Hub" },
      scenes: [{ guid: "scene-2", scene: { name: "Level2" } }],
      inspectNodes: [
        { kind: "actor", label: "Hero", id: "hero-guid" },
        { kind: "component", label: "Mesh", id: "mesh-1" },
      ],
    });
    expect(context.scenes).toEqual(["Hub", "scene-1", "Level2", "scene-2"]);
    expect(context.actors).toEqual(["Hero", "hero-guid"]);
    expect(context.commands).toContain("changescene");
    expect(context.commands).toContain("pause");
  });
});
