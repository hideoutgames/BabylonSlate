import { describe, expect, it } from "vitest";
import { InputResolver } from "./resolver";
import type { RawInputEvent } from "./ring-buffer";

const key = (code: string, phase: "down" | "up" = "down"): RawInputEvent => ({
  kind: "key",
  code,
  phase,
  tick: 0,
});

const jumpMappings = () => ({
  actions: [
    {
      id: "jump",
      name: "Jump",
      bindings: [{ id: "keyboard", device: "key" as const, code: "Space" }],
    },
  ],
  axes: [],
});
const jump = { Name: "Jump", Asset: "jump" };

describe("runtime input bindings", () => {
  it("requires the modifier chord stored on an imported edit", () => {
    const resolver = new InputResolver(jumpMappings());
    const saved = JSON.stringify({
      version: 2,
      edits: [
        {
          kind: "action",
          mapping: "jump",
          id: "keyboard",
          added: false,
          binding: {
            id: "keyboard",
            device: "key",
            code: "KeyJ",
            modifiers: { ctrl: true },
          },
        },
      ],
    });
    expect(resolver.bindings.importBindings(saved)).toBe(true);
    expect(resolver.resolve([key("KeyJ")]).actions.Jump?.pressed).toBe(false);
    resolver.resolve([key("KeyJ", "up")]);
    expect(
      resolver.resolve([key("ControlLeft"), key("KeyJ")]).actions.Jump?.pressed,
    ).toBe(true);
    expect(resolver.resolve([key("ControlLeft", "up")]).actions.Jump).toEqual({
      pressed: false,
      released: true,
      held: false,
    });
    expect(resolver.bindings.getInputBindings(jump)).toMatchObject([
      { Ctrl: true, Shift: false, Label: "Ctrl + J" },
    ]);
  });

  it("round trips edits and rejects malformed imports atomically", () => {
    const original = new InputResolver(jumpMappings());
    const keyboard = original.bindings.getInputBindings(jump)[0]!;
    expect(original.bindings.setInputActionBinding(keyboard, "KeyJ")).toBe(true);
    const saved = original.bindings.exportBindings();
    const next = new InputResolver(jumpMappings());
    expect(next.bindings.importBindings(saved)).toBe(true);
    expect(next.resolve([key("KeyJ")]).actions.Jump?.pressed).toBe(true);
    expect(next.reset().actions.Jump).toEqual({ pressed: false, released: false, held: false });
    expect(JSON.parse(next.bindings.exportBindings())).toEqual(JSON.parse(saved));
    expect(next.resolve([key("KeyJ")]).actions.Jump?.pressed).toBe(true);
    const malformed = JSON.parse(saved);
    malformed.edits[0].binding.code = "KeyH";
    malformed.edits.push({});
    expect(next.bindings.importBindings(JSON.stringify(malformed))).toBe(false);
    expect(JSON.parse(next.bindings.exportBindings())).toEqual(JSON.parse(saved));
    expect(next.bindings.importBindings("not json")).toBe(false);
    expect(next.bindings.importBindings('{"version":1,"overrides":[]}')).toBe(
      false,
    );
    next.bindings.resetBindings();
    expect(JSON.parse(next.bindings.exportBindings())).toEqual({
      version: 2,
      edits: [],
    });
    expect(next.resolve([key("Space")]).actions.Jump).toEqual({
      pressed: true,
      released: true,
      held: true,
    });
    const changedDefaults = jumpMappings();
    changedDefaults.actions[0]!.bindings[0]!.id = "space";
    const updatedGame = new InputResolver(changedDefaults);
    expect(updatedGame.bindings.importBindings(saved)).toBe(false);
    expect(updatedGame.resolve([key("KeyJ")]).actions.Jump?.held).toBe(false);
  });
});
