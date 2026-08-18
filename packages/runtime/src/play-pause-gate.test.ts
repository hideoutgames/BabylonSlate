import { describe, expect, it } from "vitest";
import { createPlayPauseGate } from "./play-pause-gate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createPlayPauseGate", () => {
  it("applies setPaused after play boot so resume() cannot undo Pause On Play", async () => {
    const events: string[] = [];
    const scripts = deferred<void>();
    const gate = createPlayPauseGate({
      pause: () => {
        events.push("pause");
      },
      resume: () => {
        events.push("resume");
      },
    });

    const playing = gate.beginPlay(async () => {
      await scripts.promise;
      events.push("start");
      events.push("resume");
    });
    gate.setPaused(true);
    expect(events).toEqual([]);

    scripts.resolve();
    await playing;
    expect(events).toEqual(["start", "resume", "pause"]);
  });

  it("pauses immediately when play boot has already finished", async () => {
    const events: string[] = [];
    const gate = createPlayPauseGate({
      pause: () => {
        events.push("pause");
      },
      resume: () => {
        events.push("resume");
      },
    });
    await gate.beginPlay(async () => {
      events.push("start");
    });
    gate.setPaused(true);
    expect(events).toEqual(["start", "pause"]);
  });
});
