import { describe, expect, it } from "vitest";
import { CommandBus } from "./command-bus";

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
