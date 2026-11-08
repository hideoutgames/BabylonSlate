import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { Actor } from "@haptic/object-model";
import { createAudioHostBindings } from "./audio-particle-emitter";
import { RuntimeVoices } from "./runtime-voices";
import { ScriptHost } from "./script-host";

/** A script context over the runtime's real audio bindings, whose commands the voice tracker observes as the driver does. */
function soundContext() {
  const voices = new RuntimeVoices(() => 1);
  const commands: CommandMessage[] = [];
  const emit = (command: CommandMessage) => {
    commands.push(command);
    voices.observe(command);
  };
  const ctx = new ScriptHost({
    log: () => {}, print: () => {}, destroyActor: () => {}, reportError: () => {}, delay: async () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    ...createAudioHostBindings({ frameId: () => 7, scriptVoiceId: () => voices.scriptVoiceId(), emit, voices }),
  }).createContext(new Actor({ classId: "Hero", guid: "hero" }), 0, 0);
  return { ctx, voices, commands, emit };
}

describe("Sound Handle nodes", () => {
  it("names each script voice by its handle and drives it through the handle", () => {
    const { ctx, voices, commands, emit } = soundContext();
    const first = ctx.playSound("clip", 0.5);
    const located = ctx.playSoundAtLocation("clip", { x: 1, y: 2, z: 3 }, 1, 2);
    expect([first, located]).toEqual([{ Id: 1 }, { Id: 2 }]);
    expect(commands.map((command) => command.type === "playSound" ? [command.voiceId, command.emitterActorGuid, command.location, command.pitch] : null))
      .toEqual([["script:1", "hero", undefined, undefined], ["script:2", "hero", { x: 1, y: 2, z: 3 }, 2]]);

    commands.length = 0;
    ctx.setSoundPitch(located, 0.5);
    ctx.setSoundVolume(located, 3);
    ctx.fadeInSound(first, 2, 0.8);
    expect(commands).toEqual([
      { type: "setVoicePitch", voiceId: "script:2", pitch: 0.5 },
      { type: "setVoiceGain", voiceId: "script:2", volume: 1 },
      { type: "setVoiceGain", voiceId: "script:1", volume: 0 },
    ]);
    for (const command of voices.advance(1)) emit(command);
    expect(commands.at(-1)).toEqual({ type: "setVoiceGain", voiceId: "script:1", volume: 0.4 });

    commands.length = 0;
    ctx.fadeOutSound(located, 0);
    ctx.stopSoundHandle(first);
    // A zero-length fade out silences and stops at once.
    expect(commands).toEqual([
      { type: "setVoiceGain", voiceId: "script:2", volume: 0 },
      { type: "stopSound", voiceId: "script:2" },
      { type: "stopSound", voiceId: "script:1" },
    ]);
    expect([ctx.isSoundPlaying(first), ctx.isSoundPlaying(located)]).toEqual([false, false]);

    // A stopped, empty or foreign handle sends nothing.
    commands.length = 0;
    for (const handle of [first, { Id: 0 }, null, { Id: 1.5 }, "script:1"]) {
      ctx.stopSoundHandle(handle);
      ctx.setSoundPitch(handle, 2);
      ctx.setSoundVolume(handle, 1);
      ctx.fadeOutSound(handle, 1);
    }
    expect(commands).toEqual([]);
  });
});
