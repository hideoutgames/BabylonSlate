import { expect, it } from "vitest";
import { createActor, createDefaultScene } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { createInProcessRuntime } from "./driver";

function sceneWithPass() {
  const scene = createDefaultScene();
  return {
    ...scene,
    actors: [createActor("hero", "Hero")],
    settings: { ...scene.settings, postProcessStack: [{ id: "bloom-pass", materialGuid: "bloom", enabled: true, scalable: true }] },
  };
}

it("adds and removes passes on the current Scene and sends its stack to the renderer", () => {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    preferSoftwarePhysics: true,
    playScene: sceneWithPass(),
    onCommand: (command) => commands.push(command),
  });
  try {
    runtime.realizePlayWorld();
    const scene = runtime.getWorld().currentScene!;
    const stacks = () => commands.flatMap((command) => command.type === "scenePostProcess" ? [command.postProcessStack] : []);
    expect(runtime.registerScenePostProcess(" vignette ")).toEqual({ owner: scene, entryId: expect.any(String) });
    expect(scene.postProcessStack).toEqual([
      { id: "bloom-pass", materialGuid: "bloom", enabled: true, scalable: true },
      { id: expect.any(String), materialGuid: "vignette", enabled: true },
    ]);
    expect(stacks().at(-1)).toEqual(scene.postProcessStack);
    // The renderer gets a copy, not the Scene's own entries.
    expect(stacks().at(-1)![0]).not.toBe(scene.postProcessStack[0]);
    runtime.unregisterScenePostProcess("bloom");
    expect(scene.postProcessStack.map((entry) => entry.materialGuid)).toEqual(["vignette"]);
    expect(stacks().at(-1)!.map((entry) => entry.materialGuid)).toEqual(["vignette"]);
    // A pass registered again is a new entry.
    const removedId = scene.postProcessStack[0]!.id;
    runtime.unregisterScenePostProcess("vignette");
    runtime.registerScenePostProcess("vignette");
    expect(scene.postProcessStack[0]!.id).not.toBe(removedId);
    // Nothing to register, or nothing registered to remove, changes nothing.
    const sent = stacks().length;
    runtime.registerScenePostProcess("  ");
    expect(() => runtime.unregisterScenePostProcess("missing")).not.toThrow();
    expect(stacks()).toHaveLength(sent);
    expect(commands.some((command) =>
      command.type === "log" && command.severity === "error" && command.message.includes("missing"))).toBe(true);
  } finally {
    runtime.stop();
  }
});
