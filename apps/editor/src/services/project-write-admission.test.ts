import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { admitOwnerWrites, guardProjectStorage, ProjectWriteAdmission, withProjectWriter } from "./project-write-admission";

describe("project write admission", () => {
  it("drains complete admitted operations before locking while refusing new public writes", async () => {
    const raw = new MemoryStorageAdapter("documents");
    await raw.openDocumentsProject("Writes");
    const admission = new ProjectWriteAdmission();
    const internal = guardProjectStorage(raw, admission, true);
    const publicStorage = guardProjectStorage(raw, admission);
    let continueSave!: () => void;
    let firstWritten!: () => void;
    const first = new Promise<void>(resolve => { firstWritten = resolve; });
    const next = new Promise<void>(resolve => { continueSave = resolve; });
    const owner = admitOwnerWrites({
      async save() {
        await internal.writeText("first", "before");
        firstWritten();
        await next;
        await this.finish();
      },
      async finish() { await internal.writeText("second", "after"); },
    }, admission, ["save", "finish"]);
    const saving = owner.save();
    await first;
    const lease = admission.lock("Session is preparing.");
    expect(admission.locked).toBe(false);
    await expect(owner.finish()).rejects.toThrow("Session is preparing.");
    await expect(publicStorage.writeText("new", "blocked")).rejects.toThrow("Session is preparing.");
    continueSave();
    await saving;
    expect(await lease.ready).toBe(true);
    expect(await publicStorage.readText("second")).toBe("after");
    expect(await raw.exists("new")).toBe(false);
    await expect(internal.writeText("late", "blocked")).rejects.toThrow("Session is preparing.");
    lease.release();
    await publicStorage.writeText("new", "allowed");
    expect(await raw.readText("new")).toBe("allowed");
  });

  it("keeps other locks active and can cancel a pending lease without stranding admission", async () => {
    const admission = new ProjectWriteAdmission();
    let finish!: () => void;
    const pending = admission.run(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = admission.lock("First owner");
    const second = admission.lock("Second owner");
    first.release();
    first.release();
    expect(await first.ready).toBe(false);
    await expect(admission.run(() => "new")).rejects.toThrow("Second owner");
    finish();
    await pending;
    expect(await second.ready).toBe(true);
    second.release();
    expect(await admission.run(() => "accepted")).toBe("accepted");
  });

  it("settles a failed admitted operation after its rollback before acquiring the lock", async () => {
    const admission = new ProjectWriteAdmission();
    let fail!: () => void;
    let rolledBack = false;
    const write = admission.run(async () => {
      try { await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("Write failed")); }); }
      finally { await Promise.resolve(); rolledBack = true; }
    });
    const rejected = expect(write).rejects.toThrow("Write failed");
    const lease = admission.lock("Read-only");
    fail();
    await rejected;
    expect(await lease.ready).toBe(true);
    expect(rolledBack).toBe(true);
    expect(admission.pendingOperations).toBe(0);
    lease.release();
  });

  it("drains child writes and revokes the scoped writer before another operation can reuse it", async () => {
    const admission = new ProjectWriteAdmission();
    let finishWrite!: () => void;
    let escaped!: { write(): Promise<void> };
    const saving = withProjectWriter(admission, {
      write: () => new Promise<void>(resolve => { finishWrite = resolve; }),
    }, async writer => {
      escaped = writer;
      void writer.write();
      return "saved";
    });
    await Promise.resolve();
    const lease = admission.lock("Preparing");
    expect(admission.locked).toBe(false);
    await expect(escaped.write()).rejects.toThrow("scope has closed");
    finishWrite();
    expect(await saving).toBe("saved");
    expect(await lease.ready).toBe(true);
    lease.release();
    await admission.run(async () => {
      await expect(escaped.write()).rejects.toThrow("scope has closed");
    });
  });

  it("fails an admitted scope when an unawaited child write fails", async () => {
    const admission = new ProjectWriteAdmission();
    const save = withProjectWriter(admission, {
      write: async () => { throw new Error("No space"); },
    }, async writer => { void writer.write(); });
    await expect(save).rejects.toThrow("No space");
    expect(admission.pendingOperations).toBe(0);
  });
});
