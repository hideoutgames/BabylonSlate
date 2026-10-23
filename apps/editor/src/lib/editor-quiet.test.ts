import { afterEach, describe, expect, it } from "vitest";
import { setEditorQuiet, whenEditorAwake } from "./editor-quiet";

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => { done = true; });
  await Promise.resolve();
  return done;
};

describe("whenEditorAwake", () => {
  afterEach(() => setEditorQuiet(false));

  it("waits while a game covers the editor and resolves once it is back", async () => {
    setEditorQuiet(true);
    const awake = whenEditorAwake(new AbortController().signal);
    expect(await settled(awake)).toBe(false);
    setEditorQuiet(false);
    expect(await settled(awake)).toBe(true);
  });

  it("lets a waiter go when its owner aborts, without waking the editor", async () => {
    setEditorQuiet(true);
    const owner = new AbortController();
    const awake = whenEditorAwake(owner.signal);
    owner.abort();
    expect(await settled(awake)).toBe(true);
    expect(await settled(whenEditorAwake(new AbortController().signal))).toBe(false);
  });
});
