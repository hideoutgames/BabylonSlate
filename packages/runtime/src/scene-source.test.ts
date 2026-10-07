import { describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createSceneSourceClient, createSceneSourceHost, type RuntimeSceneSource } from "./scene-source";

describe("Scene source ownership across the worker boundary", () => {
  it("keeps a prepared source until release and lets another consumer survive", async () => {
    let leases = 0;
    const client = createSceneSourceClient((command) => host.receive(command));
    const host = createSceneSourceHost({
      acquireScene: async () => { leases++; return { scene: createDefaultScene(), release: () => { leases--; } }; },
      send: (control) => { if (control.type === "sceneSourceResponse") client.receive(control); },
    });
    const leftAbort = new AbortController();
    const [left, right] = await Promise.all([
      client.acquireScene("child", { consumer: "left", signal: leftAbort.signal }),
      client.acquireScene("child", { consumer: "right", signal: new AbortController().signal }),
    ]);
    expect(leases).toBe(2);
    // A ready instance must retain sources through its teardown after cancellation.
    leftAbort.abort();
    expect(leases).toBe(2);
    left.release();
    left.release();
    expect(leases).toBe(1);
    right.release();
    expect(leases).toBe(0);
    client.dispose();
    host.dispose();
  });

  it("rejects cancellation promptly and releases a late provider result without publishing it", async () => {
    let finish!: (source: RuntimeSceneSource) => void;
    const release = vi.fn();
    const responses: unknown[] = [];
    const client = createSceneSourceClient((command) => host.receive(command));
    const host = createSceneSourceHost({
      acquireScene: () => new Promise((resolve) => { finish = resolve; }),
      send: (control) => { responses.push(control); if (control.type === "sceneSourceResponse") client.receive(control); },
    });
    const controller = new AbortController();
    const pending = client.acquireScene("child", { consumer: "cancelled actor", signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    finish({ scene: createDefaultScene(), release });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(responses).toEqual([]);
    host.dispose();
    client.dispose();
  });

  it("does not publish a previous project's response into a replacement client", async () => {
    const requests: CommandMessage[] = [];
    const first = createSceneSourceClient((message) => requests.push(message));
    const pending = first.acquireScene("scene", { consumer: "old project", signal: new AbortController().signal });
    first.dispose();
    await expect(pending).rejects.toThrow();
    const second = createSceneSourceClient((message) => requests.push(message));
    const replacement = second.acquireScene("scene", { consumer: "new project", signal: new AbortController().signal });
    const loads = requests.filter((message) => message.type === "sceneSourceRequested");
    let published = false;
    void replacement.then(() => { published = true; });
    second.receive({ type: "sceneSourceResponse", requestId: loads[0]!.requestId, scene: createDefaultScene() });
    await Promise.resolve();
    expect(published).toBe(false);
    second.receive({ type: "sceneSourceResponse", requestId: loads[1]!.requestId, scene: createDefaultScene() });
    (await replacement).release();
    second.dispose();
  });
});
