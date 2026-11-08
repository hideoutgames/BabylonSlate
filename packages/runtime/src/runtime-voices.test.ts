import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { RuntimeVoices } from "./runtime-voices";

const play = (voiceId: string): CommandMessage => ({ type: "playSound", assetGuid: "clip", volume: 1, frameId: 1, voiceId });
const liveIds = (voices: RuntimeVoices) => voices.traceState().voices.map((voice) => voice.voiceId);

describe("RuntimeVoices live voices", () => {
  it("records each voice until it stops or the host reports it ended", () => {
    const voices = new RuntimeVoices(() => 1);
    voices.observe(play("a"));
    voices.observe(play("b"));
    expect(liveIds(voices)).toEqual(["a", "b"]);
    voices.observe({ type: "stopSound", voiceId: "a" });
    expect(liveIds(voices)).toEqual(["b"]);
    voices.ended("b");
    expect(liveIds(voices)).toEqual([]);
  });

  it("moves a replayed voice to the end and forgets every voice when the active Scene changes", () => {
    const voices = new RuntimeVoices(() => 1);
    voices.observe(play("a"));
    voices.observe(play("b"));
    voices.observe(play("a"));
    expect(liveIds(voices)).toEqual(["b", "a"]);

    voices.observe({ type: "activeScene", sceneAssetGuid: "first", sceneLoadId: 1 });
    voices.observe({ type: "activeScene", sceneAssetGuid: "first", sceneLoadId: 2 });
    expect(liveIds(voices)).toEqual(["b", "a"]);
    voices.observe({ type: "activeScene", sceneAssetGuid: "second", sceneLoadId: 3 });
    expect(liveIds(voices)).toEqual([]);
  });
});
