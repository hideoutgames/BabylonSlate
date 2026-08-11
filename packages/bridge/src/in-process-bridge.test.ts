import { describe, expect, it } from "vitest";
import { createInProcessBridge } from "./in-process-bridge";

describe("createInProcessBridge", () => {
  it("creates a transferable host when requested", () => {
    const bridge = createInProcessBridge({ maxActors: 4, mode: "transferable" });
    expect(bridge.mode).toBe("transferable");
    const commands: string[] = [];
    bridge.onCommand((msg) => commands.push(msg.type));
    bridge.postControl({ type: "play" });
    expect(commands).toEqual([]);
  });

  it("creates a sab host when SharedArrayBuffer is available", () => {
    const bridge = createInProcessBridge({ maxActors: 4, mode: "sab" });
    expect(bridge.mode === "sab" || bridge.mode === "transferable").toBe(true);
    expect(bridge.snapshots).toBeTruthy();
  });
});
