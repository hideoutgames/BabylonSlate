import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitTestServer, REPOSITORY_URL, STORAGE_ORIGIN } from "../test-support/git-server";
import { runGitBenchmark } from "./benchmark";

let server: GitTestServer;

beforeEach(async () => {
  server = await GitTestServer.start();
});

afterEach(async () => {
  await server.stop();
});

describe("runGitBenchmark", { timeout: 60_000 }, () => {
  it("measures each step, reads no file for the unchanged status and touches only its own branch", async () => {
    const main = server.seed({ "project.json": "{}\n", "assets/a.hasset": "A", "assets/b.hasset": "B" });
    let clock = 0;
    const result = await runGitBenchmark({
      storage: await server.storage(),
      http: server.http,
      credential: server.credential(),
      repositoryUrl: REPOSITORY_URL,
      branch: "main",
      remoteBranch: "haptic-benchmark-test",
      author: { name: "Benchmark", email: "benchmark@example.com" },
      blobs: { count: 2, size: 4096 },
      timer: () => (clock += 5),
    });

    expect(result).toMatchObject({
      files: 3,
      unchangedStatusChanges: 0,
      status: { workingReads: 0, sent: 0, received: 0 },
      lfsUpload: { objects: 2, bytes: 8192 },
      lfsDownload: { objects: 2, bytes: 8192 },
    });
    for (const step of [result.clone, result.status, result.commit, result.push, result.lfsUpload, result.lfsDownload]) expect(step.ms).toBeGreaterThan(0);
    expect(result.clone.received).toBeGreaterThan(0);
    expect(result.lfsUpload.sent).toBeGreaterThanOrEqual(8192);
    expect(result.lfsDownload.received).toBeGreaterThanOrEqual(8192);
    expect(server.git(server.bare, "rev-parse", "main").trim()).toBe(main);
    expect(server.git(server.bare, "rev-list", "--count", "main..haptic-benchmark-test").trim()).toBe("2");
    expect(server.requests.filter((request) => request.origin === STORAGE_ORIGIN && request.method === "PUT")).toHaveLength(2);
    expect(server.objects.size).toBe(2);
  });
});
