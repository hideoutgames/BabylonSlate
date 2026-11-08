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

  it("ramps a fading voice each tick, stops it after a fade out and drops the fade with the voice", () => {
    const voices = new RuntimeVoices(() => 1);
    const send = (commands: CommandMessage[]) => {
      for (const command of commands) voices.observe(command);
      return commands;
    };
    voices.observe({ type: "playSound", assetGuid: "a", volume: 0.8, frameId: 0, voiceId: "script:1" });
    expect(send(voices.fade("script:1", 1, 0, { stopAtEnd: true }))).toEqual([{ type: "setVoiceGain", voiceId: "script:1", volume: 0.8 }]);
    expect(send(voices.advance(0.25))).toEqual([{ type: "setVoiceGain", voiceId: "script:1", volume: expect.closeTo(0.6, 9) }]);
    expect(send(voices.advance(1))).toEqual([
      { type: "setVoiceGain", voiceId: "script:1", volume: 0 },
      { type: "stopSound", voiceId: "script:1" },
    ]);
    expect(voices.isLive("script:1")).toBe(false);
    expect(voices.advance(1)).toEqual([]);

    // A fade in starts silent; a new fade replaces it, and a voice that ends takes its fade with it.
    voices.observe({ type: "playSound", assetGuid: "a", volume: 1, frameId: 0, voiceId: "script:2" });
    expect(send(voices.fade("script:2", 2, 0.5, { from: 0 }))).toEqual([{ type: "setVoiceGain", voiceId: "script:2", volume: 0 }]);
    expect(send(voices.advance(1))).toEqual([{ type: "setVoiceGain", voiceId: "script:2", volume: 0.25 }]);
    expect(send(voices.fade("script:2", 0, 0.9))).toEqual([{ type: "setVoiceGain", voiceId: "script:2", volume: 0.9 }]);
    expect(voices.advance(1)).toEqual([]);
    send(voices.fade("script:2", 4, 0));
    voices.ended("script:2");
    expect(voices.advance(1)).toEqual([]);
    expect(voices.fade("script:9", 1, 0)).toEqual([]);
  });
});
