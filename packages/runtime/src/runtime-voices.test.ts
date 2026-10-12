import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { RuntimeVoices } from "./runtime-voices";

const play = (voiceId: string, restoredAtSeconds?: number): CommandMessage => ({
  type: "playSound", assetGuid: "clip", volume: 1, frameId: 1, voiceId,
  ...(restoredAtSeconds === undefined ? {} : { restoredAtSeconds }),
});

describe("RuntimeVoices restored voices", () => {
  it("are reported only while a trace-restored voice is live", () => {
    const voices = new RuntimeVoices(() => 1);
    voices.observe(play("ordinary"));
    expect(voices.hasRestoredVoices).toBe(false);

    voices.observe(play("a", 2));
    voices.observe(play("b", 2));
    expect(voices.hasRestoredVoices).toBe(true);
    voices.observe({ type: "stopSound", voiceId: "a" });
    expect(voices.hasRestoredVoices).toBe(true);
    voices.ended("b");
    expect(voices.hasRestoredVoices).toBe(false);
  });

  it("stop being reported when an ordinary play replaces the voice or the active Scene changes", () => {
    const voices = new RuntimeVoices(() => 1);
    voices.observe(play("a", 2));
    voices.observe(play("a"));
    expect(voices.hasRestoredVoices).toBe(false);

    voices.observe({ type: "activeScene", sceneAssetGuid: "first", sceneLoadId: 1 });
    voices.observe(play("b", 2));
    voices.observe({ type: "activeScene", sceneAssetGuid: "first", sceneLoadId: 2 });
    expect(voices.hasRestoredVoices).toBe(true);
    voices.observe({ type: "activeScene", sceneAssetGuid: "second", sceneLoadId: 3 });
    expect(voices.hasRestoredVoices).toBe(false);
  });
});
