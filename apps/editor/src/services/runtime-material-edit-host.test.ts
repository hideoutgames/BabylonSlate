import { describe, expect, it, vi } from "vitest";
import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import { RuntimeMaterialEditHost } from "./runtime-material-edit-host";

const prepare: Extract<CommandMessage, { type: "prepareRuntimeMaterialEdit" }> = {
  type: "prepareRuntimeMaterialEdit", sessionGeneration: 4, requestId: 12, editToken: "stage12",
  slotId: 2, actorGuid: "actor", componentId: "mesh", materialGuid: "material",
};
const commit: Extract<CommandMessage, { type: "assignMaterial" }> = {
  type: "assignMaterial", slotId: 2, componentId: "mesh", materialAssetGuid: "material", preparedEditToken: "stage12",
};
function fixture() {
  let finish!: () => void, fail!: (reason: Error) => void;
  const loading = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const responses: ControlMessage[] = [];
  const ports = { sessionGeneration: 4, mode: "simulate" as const, prepare: vi.fn(() => loading),
    commit: vi.fn((): { success: boolean; reason?: string } => ({ success: true })), release: vi.fn(),
    respond: (response: ControlMessage) => { responses.push(response); } };
  return { host: new RuntimeMaterialEditHost(ports), ports, responses, finish, fail };
}

describe("runtime material edit host", () => {
  it("prepares before acknowledgment, commits once via the staged path, and releases its token", async () => {
    const { host, ports, responses, finish } = fixture();
    expect(host.receive(prepare)).toBe(true);
    await Promise.resolve();
    expect(ports.prepare).toHaveBeenCalledOnce();
    expect(responses).toHaveLength(0);
    finish();
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({ type: "runtimeMaterialEditPrepared", success: true, requestId: 12 });
    expect(host.receive(commit)).toBe(true);
    expect(ports.commit).toHaveBeenCalledWith(commit);
    expect(responses[1]).toMatchObject({ type: "runtimeMaterialEditApplied", success: true, editToken: "stage12" });
    host.receive({ type: "releaseRuntimeMaterialPreparation", sessionGeneration: 4, editToken: "stage12", committed: true });
    host.dispose();
    expect(ports.release).toHaveBeenCalledTimes(1);
    expect(host.receive({ ...commit, preparedEditToken: "unknown" })).toBe(true);
    expect(ports.commit).toHaveBeenCalledTimes(1);
    expect(host.receive({ type: "assignMaterial", slotId: 2, materialAssetGuid: "gameplay-material" })).toBe(false);
  });

  it("rejects failed preparation and changed owner state without falling through to direct assignment", async () => {
    const { host, ports, responses, fail } = fixture();
    host.receive(prepare);
    await Promise.resolve();
    fail(new Error("Texture unavailable"));
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({ success: false, reason: "Texture unavailable" });
    expect(host.receive(commit)).toBe(true);
    expect(ports.commit).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledOnce();
    host.dispose();

    const changed = fixture();
    changed.host.receive(prepare);
    changed.finish();
    await vi.waitFor(() => expect(changed.responses).toHaveLength(1));
    changed.ports.commit.mockReturnValue({ success: false, reason: "Context lost" });
    changed.host.receive(commit);
    expect(changed.responses[1]).toMatchObject({ type: "runtimeMaterialEditApplied", success: false, reason: "Context lost" });
    expect(changed.ports.release).toHaveBeenCalledOnce();
    changed.host.dispose();
  });

  it.each(["invalidate", "dispose"] as const)("clears preparations on %s and ignores late completion", async action => {
    const { host, ports, responses, finish } = fixture();
    host.receive(prepare);
    await Promise.resolve();
    host[action]();
    expect(ports.release).toHaveBeenCalledOnce();
    const count = responses.length;
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(responses).toHaveLength(count);
    host.receive(commit);
    expect(ports.commit).not.toHaveBeenCalled();
    host.dispose();
  });

  it("rejects unexpected generations and bounds explicit material preparations", async () => {
    const { host, ports, responses } = fixture();
    host.receive({ ...prepare, sessionGeneration: 3 });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(responses).toHaveLength(0);
    for (let index = 0; index < 9; index++) host.receive({ ...prepare, requestId: 20 + index, editToken: `stage${index}` });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ requestId: 28, success: false });
    host.dispose();
    expect(ports.release).toHaveBeenCalledTimes(8);
    await Promise.resolve();
    expect(ports.prepare).not.toHaveBeenCalled();
  });
});
