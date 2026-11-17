import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http";
import { countingStorage, GitTestServer, REPOSITORY_URL, STORAGE_ORIGIN } from "../test-support/git-server";
import { GIT_BENCHMARK_STAGES, runGitBenchmark, type GitBenchmarkOptions, type GitBenchmarkStage } from "./benchmark";

let server: GitTestServer;

beforeEach(async () => {
  server = await GitTestServer.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
});

function options(overrides: Partial<GitBenchmarkOptions> & Pick<GitBenchmarkOptions, "storage">): GitBenchmarkOptions {
  let clock = 0;
  return {
    http: server.http,
    credential: server.credential(),
    repositoryUrl: REPOSITORY_URL,
    branch: "main",
    remoteBranch: "haptic-benchmark-test",
    author: { name: "Benchmark", email: "benchmark@example.com" },
    blobs: { count: 2, size: 4096 },
    timer: () => (clock += 5),
    ...overrides,
  };
}

/** LFS objects read or written through JavaScript storage (not the `.gitignore` lookups Git makes in every folder). */
const blobIo = (paths: readonly string[]) => paths.filter((path) => /\.blobs\/[0-9a-f]{64}$/.test(path));

describe("runGitBenchmark", { timeout: 60_000 }, () => {
  it("measures each step, reads no file for the unchanged status and touches only its own branch", async () => {
    const main = server.seed({ "project.json": "{}\n", "assets/a.hasset": "A", "assets/b.hasset": "B" });
    const stages: GitBenchmarkStage[] = [];
    const result = await runGitBenchmark(options({ storage: await server.storage(), onStage: (stage) => void stages.push(stage) }));

    expect(result).toMatchObject({
      transfer: "whole-body",
      files: 3,
      unchangedStatusChanges: 0,
      status: { workingReads: 0, sent: 0, received: 0 },
      createObjects: { objects: 2, bytes: 8192 },
      lfsUpload: { objects: 2, bytes: 8192 },
      lfsDownload: { objects: 2, bytes: 8192 },
    });
    expect(stages).toEqual([...GIT_BENCHMARK_STAGES]);
    for (const step of [result.clone, result.status, result.commit, result.push, result.createObjects, result.lfsCommit, result.lfsUpload, result.lfsDownload]) expect(step.ms).toBeGreaterThan(0);
    expect(result.clone.received).toBeGreaterThan(0);
    expect(result.lfsUpload.sent).toBeGreaterThanOrEqual(8192);
    expect(result.lfsDownload.received).toBeGreaterThanOrEqual(8192);
    expect(server.git(server.bare, "rev-parse", "main").trim()).toBe(main);
    expect(server.git(server.bare, "rev-list", "--count", "main..haptic-benchmark-test").trim()).toBe("2");
    expect(server.requests.filter((request) => request.origin === STORAGE_ORIGIN && request.method === "PUT")).toHaveLength(2);
    expect(server.objects.size).toBe(2);
  });

  // 3 × 256 MiB objects held at once ran an iPad out of memory before this: each is made and written before the next.
  it("makes the objects in JavaScript one at a time when the host cannot", async () => {
    server.seed({ "project.json": "{}\n" });
    const events: string[] = [];
    const random = crypto.getRandomValues.bind(crypto) as (array: Uint8Array) => Uint8Array;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      events.push("make");
      return random(array);
    }) as typeof crypto.getRandomValues);
    const storage = await server.storage();
    const write = storage.writeBinary.bind(storage);
    let stage: GitBenchmarkStage | null = null;
    storage.writeBinary = async (path, bytes) => {
      if (stage === "create-objects" && blobIo([path]).length > 0) events.push("write");
      return write(path, bytes);
    };

    await runGitBenchmark(options({ storage, blobs: { count: 3, size: 4096 }, onStage: (next) => void (stage = next) }));
    expect(events).toEqual(["make", "write", "make", "write", "make", "write"]);
  });

  it("streams through the host's file transfer, which also makes the objects: none passes through JavaScript", async () => {
    server.seed({ "project.json": "{}\n", "assets/a.hasset": "A" });
    const { storage, reads, writes } = countingStorage(await server.storage());
    const made: string[] = [];
    const randomObject = server.randomObjects(storage);
    const result = await runGitBenchmark(options({
      storage,
      files: server.files(storage),
      writeRandomObject: async (directory, size) => {
        const object = await randomObject(directory, size);
        made.push(object.path);
        return object;
      },
    }));

    expect(result).toMatchObject({ transfer: "native", createObjects: { objects: 2, bytes: 8192 }, lfsUpload: { objects: 2 }, lfsDownload: { objects: 2 } });
    expect(made).toHaveLength(2);
    expect(blobIo(reads)).toEqual([]);
    expect(blobIo(writes)).toEqual([]);
    expect(result.lfsUpload.sent).toBeGreaterThanOrEqual(8192);
    expect(result.lfsDownload.received).toBeGreaterThanOrEqual(8192);
    expect(server.objects.size).toBe(2);
  });

  it("has named the stage it was in when it fails", async () => {
    server.seed({ "project.json": "{}\n" });
    const stages: GitBenchmarkStage[] = [];
    const refusingStore: HttpClient = async (request) =>
      request.url.startsWith(STORAGE_ORIGIN) && request.method === "PUT" ? { status: 507, bodyText: "" } : server.http(request);

    await expect(runGitBenchmark(options({ storage: await server.storage(), http: refusingStore, onStage: (stage) => void stages.push(stage) }))).rejects.toMatchObject({ status: 507 });
    expect(stages.at(-1)).toBe("lfs-upload");
  });
});
