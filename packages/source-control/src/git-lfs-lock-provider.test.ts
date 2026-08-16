import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@babylonslate/core";
import { GitLfsLockProvider } from "./git-lfs-lock-provider";
import { LFS_JSON, type LfsRequest, type LfsResponse } from "./types";

function jsonResponse(status: number, body: unknown): LfsResponse {
  return { status, bodyText: JSON.stringify(body) };
}

const sampleLock = {
  id: "lock-1",
  path: "assets/hero.scene.babasset",
  locked_at: "2026-08-15T12:00:00Z",
  owner: { name: "Ada" },
};

describe("GitLfsLockProvider", () => {
  it("POSTs create with vnd.git-lfs+json and Basic PAT auth", async () => {
    const calls: LfsRequest[] = [];
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      getToken: async () => "ghp_secret",
      fetch: async (request) => {
        calls.push(request);
        return jsonResponse(201, { lock: sampleLock });
      },
    });
    const result = await provider.create("assets/hero.scene.babasset");
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      id: "lock-1",
      path: "assets/hero.scene.babasset",
      ownerName: "Ada",
      lockedAt: "2026-08-15T12:00:00Z",
      ours: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://github.com/org/repo.git/info/lfs/locks",
    );
    expect(calls[0]?.headers.Accept).toBe(LFS_JSON);
    expect(calls[0]?.headers["Content-Type"]).toBe(LFS_JSON);
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${btoa("x-access-token:ghp_secret")}`,
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      path: "assets/hero.scene.babasset",
      ref: { name: "refs/heads/main" },
    });
  });

  it("maps 409 to a conflict when verify lists the lock as theirs", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo.git",
      branch: "main",
      getToken: async () => "token",
      fetch: async (request) => {
        if (request.url.endsWith("/locks/verify")) {
          return jsonResponse(200, {
            ours: [],
            theirs: [{ ...sampleLock, owner: { name: "Bob" } }],
          });
        }
        return jsonResponse(409, {
          lock: { ...sampleLock, owner: { name: "Bob" } },
          message: "already created lock",
        });
      },
    });
    const result = await provider.create("assets/hero.scene.babasset");
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.kind).toBe("conflict");
    expect(result.error.lock?.ownerName).toBe("Bob");
    expect(result.error.lock?.ours).toBe(false);
  });

  it("treats 409 as held when verify lists the path as ours", async () => {
    const urls: string[] = [];
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo.git",
      branch: "main",
      getToken: async () => "token",
      fetch: async (request) => {
        urls.push(`${request.method} ${request.url}`);
        if (request.method === "POST" && request.url.endsWith("/locks")) {
          return jsonResponse(409, {
            lock: sampleLock,
            message: "already created lock",
          });
        }
        if (request.url.endsWith("/locks/verify")) {
          return jsonResponse(200, { ours: [sampleLock], theirs: [] });
        }
        return jsonResponse(500, { message: `unexpected ${request.url}` });
      },
    });
    const result = await provider.create("assets/hero.scene.babasset");
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.ours).toBe(true);
    expect(result.value.id).toBe("lock-1");
    expect(urls.some((url) => url.endsWith("/locks/verify"))).toBe(true);
  });

  it("paginates GET /locks", async () => {
    const urls: string[] = [];
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      getToken: async () => "token",
      fetch: async (request) => {
        urls.push(request.url);
        if (!request.url.includes("cursor=")) {
          return jsonResponse(200, {
            locks: [sampleLock],
            next_cursor: "page-2",
          });
        }
        return jsonResponse(200, {
          locks: [
            {
              id: "lock-2",
              path: "assets/other.babasset",
              locked_at: "2026-08-15T13:00:00Z",
              owner: { name: "Bob" },
            },
          ],
        });
      },
    });
    const result = await provider.list();
    expect(isOk(result) && result.value.map((lock) => lock.id)).toEqual([
      "lock-1",
      "lock-2",
    ]);
    expect(urls[0]).toContain("refspec=refs%2Fheads%2Fmain");
    expect(urls[1]).toContain("cursor=page-2");
  });

  it("POSTs verify and marks ours versus theirs", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "git@github.com:org/repo.git",
      branch: "release",
      getToken: async () => "token",
      fetch: async (request) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://github.com/org/repo.git/info/lfs/locks/verify",
        );
        expect(JSON.parse(request.body ?? "{}")).toEqual({
          ref: { name: "refs/heads/release" },
        });
        return jsonResponse(200, {
          ours: [sampleLock],
          theirs: [
            {
              id: "lock-2",
              path: "assets/other.babasset",
              locked_at: "2026-08-15T13:00:00Z",
              owner: { name: "Bob" },
            },
          ],
        });
      },
    });
    const result = await provider.verify();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.ours[0]?.ours).toBe(true);
    expect(result.value.theirs[0]?.ours).toBe(false);
    expect(result.value.theirs[0]?.ownerName).toBe("Bob");
  });

  it("POSTs unlock with optional force", async () => {
    const bodies: unknown[] = [];
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      getToken: async () => "token",
      fetch: async (request) => {
        expect(request.url).toBe(
          "https://github.com/org/repo.git/info/lfs/locks/lock-1/unlock",
        );
        bodies.push(JSON.parse(request.body ?? "{}"));
        return jsonResponse(200, { lock: sampleLock });
      },
    });
    expect(isOk(await provider.unlock("lock-1"))).toBe(true);
    expect(isOk(await provider.unlock("lock-1", { force: true }))).toBe(true);
    expect(bodies).toEqual([
      { force: false, ref: { name: "refs/heads/main" } },
      { force: true, ref: { name: "refs/heads/main" } },
    ]);
  });

  it("returns unauthorized when no token is stored", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      getToken: async () => null,
      fetch: async () => jsonResponse(200, { locks: [] }),
    });
    const result = await provider.list();
    expect(isErr(result) && result.error.kind).toBe("unauthorized");
  });

  it("maps thrown fetch failures to offline", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      getToken: async () => "token",
      fetch: async () => {
        throw new Error("network down");
      },
    });
    const result = await provider.create("assets/a.babasset");
    expect(isErr(result) && result.error.kind).toBe("offline");
  });

  it("maps 401 to unauthorized", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: "main",
      getToken: async () => "bad",
      fetch: async () => jsonResponse(401, { message: "bad credentials" }),
    });
    const result = await provider.list();
    expect(isErr(result) && result.error.kind).toBe("unauthorized");
  });
});
