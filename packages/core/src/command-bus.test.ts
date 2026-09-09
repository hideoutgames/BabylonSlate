import { describe, expect, it } from "vitest";
import { CommandBus } from "./command-bus";
import * as commands from "./command-bus";

describe("CommandBus", () => {
  it("delivers dispatched commands to every subscriber", () => {
    const bus = new CommandBus();
    const seen: string[] = [];
    bus.subscribe((command) => {
      if (command.type === "log") seen.push(`a:${command.message}`);
    });
    bus.subscribe((command) => {
      if (command.type === "log") seen.push(`b:${command.message}`);
    });
    bus.dispatch({ type: "log", message: "hello" });
    expect(seen).toEqual(["a:hello", "b:hello"]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new CommandBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((command) => {
      if (command.type === "log") seen.push(command.message);
    });
    bus.dispatch({ type: "log", message: "one" });
    unsubscribe();
    bus.dispatch({ type: "log", message: "two" });
    expect(seen).toEqual(["one"]);
  });
});

describe("requestEditorDrop", () => {
  it("accepts only the result for the requesting viewport and request", () => {
    const transforms = [{
      actorId: "box",
      position: [2, 1, 3] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    }];
    const stop = commands.engineCommandBus.subscribe((command) => {
      if (command.type !== "editor.drop") return;
      expect(command.actorIds).toEqual(["box"]);
      const response = {
        type: "editor.drop.result" as const,
        viewportId: command.viewportId,
        requestId: command.requestId,
        transforms,
      };
      commands.engineCommandBus.dispatch(response);
      commands.engineCommandBus.dispatch({ ...response, viewportId: "another", transforms: [] });
      commands.engineCommandBus.dispatch({ ...response, requestId: "stale", transforms: [] });
    });
    try {
      expect(commands.requestEditorDrop("scene-view", ["box"])).toEqual(transforms);
    } finally {
      stop();
    }
    expect(commands.requestEditorDrop("closed-view", ["box"])).toEqual([]);
  });
});
