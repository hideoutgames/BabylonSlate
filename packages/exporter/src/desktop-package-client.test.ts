import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { packageDesktopGameInBackground, type DesktopPackageWorkerHandle } from "./desktop-package-client";
import { runDesktopPackage, type DesktopPackageReply, type DesktopPackageRequest } from "./desktop-package-protocol";
import type { DesktopGamePackageInput } from "./native-desktop";

function input(overrides: Partial<DesktopGamePackageInput> = {}): DesktopGamePackageInput {
  return {
    target: "linux-x64",
    runtime: zipSync({ electron: strToU8("binary"), "resources.pak": strToU8("pak") }),
    host: strToU8("host();"),
    game: new Map([["index.html", strToU8("<html>")]]),
    name: "Space Game",
    version: "1.2.0",
    gameId: "project-guid",
    appId: "com.example.spacegame",
    ...overrides,
  };
}

/** A worker that runs the request in-process, as the real worker does, or fails as scripted. */
class FakeWorker implements DesktopPackageWorkerHandle {
  onmessage: DesktopPackageWorkerHandle["onmessage"] = null;
  onerror: DesktopPackageWorkerHandle["onerror"] = null;
  onmessageerror: DesktopPackageWorkerHandle["onmessageerror"] = null;
  posted: { request: DesktopPackageRequest; transfer: Transferable[] } | null = null;
  terminated = false;
  constructor(private readonly outcome: "run" | "crash" = "run") {}
  postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    const request = message as DesktopPackageRequest;
    const transfer = Array.isArray(options) ? options : [];
    this.posted = { request, transfer };
    if (this.outcome === "crash") {
      queueMicrotask(() => this.onerror?.call(this as never, { message: "out of memory", preventDefault() {} } as ErrorEvent));
      return;
    }
    void runDesktopPackage(request).then(
      ({ fileName, bytes }) => this.reply({ ok: true, fileName, bytes }),
      (error: Error) => this.reply({ ok: false, error: error.message }),
    );
  }
  private reply(data: DesktopPackageReply) {
    this.onmessage?.call(this as never, { data } as MessageEvent);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe("packageDesktopGameInBackground", () => {
  it("makes the package on a worker, moving the runtime's buffer there and ending the worker", async () => {
    const worker = new FakeWorker();
    const request = { kind: "linux-zip", input: input() } as const;
    const runtime = request.input.runtime;
    const { fileName, bytes } = await packageDesktopGameInBackground(request, () => worker);

    expect(fileName).toBe("Space_Game-Linux.zip");
    expect(Object.keys(unzipSync(bytes))).toContain("Space Game/resources/game/index.html");
    expect(worker.posted!.transfer).toEqual([runtime.buffer]);
    expect(worker.terminated).toBe(true);
  });

  it("copies a runtime that views part of a larger buffer instead of moving that buffer", async () => {
    const zip = input().runtime;
    const storage = new Uint8Array(zip.byteLength + 8);
    storage.set(zip, 4);
    const worker = new FakeWorker();
    await packageDesktopGameInBackground({ kind: "linux-zip", input: input({ runtime: storage.subarray(4, 4 + zip.byteLength) }) }, () => worker);
    expect(worker.posted!.transfer).toEqual([]);
  });

  it("rejects with the packager's error, and with the worker's when it crashes", async () => {
    await expect(packageDesktopGameInBackground({ kind: "windows-zip", input: input({ target: "windows-x64" }) }, () => new FakeWorker()))
      .rejects.toThrow("The Windows player is damaged: electron.exe is missing.");
    const crashed = new FakeWorker("crash");
    await expect(packageDesktopGameInBackground({ kind: "linux-deb", input: input() }, () => crashed))
      .rejects.toThrow("Packaging failed: out of memory");
    expect(crashed.terminated).toBe(true);
  });

  it("packages in-process where there is no Worker", async () => {
    const { fileName } = await packageDesktopGameInBackground({ kind: "linux-deb", input: input() }, null);
    expect(fileName).toMatch(/\.deb$/);
  });
});
