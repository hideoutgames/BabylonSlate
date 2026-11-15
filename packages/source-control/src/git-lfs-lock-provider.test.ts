import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@haptic/core";
import { credentialUsername, fixedCredential, type HostCredential } from "./credentials";
import { GitLfsLockProvider } from "./git-lfs-lock-provider";
import type { HttpRequest, HttpResponse } from "./http";
import { LFS_JSON } from "./types";

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, bodyText: JSON.stringify(body) };
}

function github(token: string): HostCredential {
  return { origin: "https://github.com", username: "x-access-token", token, kind: "github" };
}

const sampleLock = {
  id: "lock-1",
  path: "assets/hero.scene.hasset",
  locked_at: "2026-08-15T12:00:00Z",
  owner: { name: "Ada" },
};

describe("GitLfsLockProvider", () => {
  it("POSTs create with vnd.git-lfs+json and Basic PAT auth", async () => {
    const calls: HttpRequest[] = [];
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("ghp_secret")),
      http: async (request) => {
        calls.push(request);
        return jsonResponse(201, { lock: sampleLock });
      },
    });
    const result = await provider.create("assets/hero.scene.hasset");
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      id: "lock-1",
      path: "assets/hero.scene.hasset",
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
    // Credentialed requests never follow a redirect to another host.
    expect(calls[0]?.disableRedirects).toBe(true);
    expect(JSON.parse((calls[0]?.body as string | undefined) ?? "{}")).toEqual({
      path: "assets/hero.scene.hasset",
      ref: { name: "refs/heads/main" },
    });
  });

  it("maps 409 to a conflict when verify lists the lock as theirs", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo.git",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
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
    const result = await provider.create("assets/hero.scene.hasset");
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
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
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
    const result = await provider.create("assets/hero.scene.hasset");
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.ours).toBe(true);
    expect(result.value.id).toBe("lock-1");
    expect(urls.some((url) => url.endsWith("/locks/verify"))).toBe(true);
  });

  it("paginates verify and stops on a repeated cursor", async () => {
    const cursors: unknown[] = [];
    let repeat = false;
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
        const cursor = (JSON.parse((request.body as string | undefined) ?? "{}") as { cursor?: string }).cursor;
        cursors.push(cursor);
        if (!cursor) {
          return jsonResponse(200, { ours: [sampleLock], theirs: [], next_cursor: "page-2" });
        }
        return jsonResponse(200, {
          ours: [],
          theirs: [
            {
              id: "lock-2",
              path: "assets/other.hasset",
              locked_at: "2026-08-15T13:00:00Z",
              owner: { name: "Bob" },
            },
          ],
          ...(repeat ? { next_cursor: "page-2" } : {}),
        });
      },
    });
    const result = await provider.verify();
    expect(isOk(result) && [...result.value.ours, ...result.value.theirs].map((lock) => lock.id)).toEqual([
      "lock-1",
      "lock-2",
    ]);
    expect(cursors).toEqual([undefined, "page-2"]);
    repeat = true;
    const looping = await provider.verify();
    expect(isErr(looping) && looping.error.kind).toBe("http");
  });

  it("POSTs verify and marks ours versus theirs", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "git@github.com:org/repo.git",
      branch: () => "release",
      credential: fixedCredential(github("token")),
      http: async (request) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://github.com/org/repo.git/info/lfs/locks/verify",
        );
        expect(JSON.parse((request.body as string | undefined) ?? "{}")).toEqual({
          ref: { name: "refs/heads/release" },
        });
        return jsonResponse(200, {
          ours: [sampleLock],
          theirs: [
            {
              id: "lock-2",
              path: "assets/other.hasset",
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
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
        expect(request.url).toBe(
          "https://github.com/org/repo.git/info/lfs/locks/lock-1/unlock",
        );
        bodies.push(JSON.parse((request.body as string | undefined) ?? "{}"));
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

  it("names the branch read at each request, and a verify's own branch when it gives one", async () => {
    const refs: unknown[] = [];
    let branch = "main";
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => branch,
      credential: fixedCredential(github("token")),
      http: async (request) => {
        refs.push((JSON.parse((request.body as string | undefined) ?? "{}") as { ref?: unknown }).ref);
        return request.url.endsWith("/verify") ? jsonResponse(200, { ours: [], theirs: [] }) : jsonResponse(201, { lock: sampleLock });
      },
    });
    await provider.verify();
    // A switch moves the next requests to the branch now checked out; nothing is rebuilt.
    branch = "feature";
    await provider.create("assets/hero.scene.hasset");
    await provider.unlock("lock-1");
    await provider.verify();
    // A push checks the locks of the branch it pushes.
    await provider.verify({ branch: "hotfix" });
    expect(refs).toEqual([
      { name: "refs/heads/main" },
      { name: "refs/heads/feature" },
      { name: "refs/heads/feature" },
      { name: "refs/heads/feature" },
      { name: "refs/heads/hotfix" },
    ]);
  });

  it("returns unauthorized without a request when no credential is stored", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: { current: async () => null, renew: async () => null },
      http: async () => {
        throw new Error("no request without a credential");
      },
    });
    const result = await provider.verify();
    expect(isErr(result) && result.error.kind).toBe("unauthorized");
  });

  it("maps thrown fetch failures to offline", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async () => {
        throw new Error("network down");
      },
    });
    const result = await provider.create("assets/a.hasset");
    expect(isErr(result) && result.error.kind).toBe("offline");
  });

  it("maps 401 to unauthorized", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("bad")),
      http: async () => jsonResponse(401, { message: "bad credentials" }),
    });
    const result = await provider.verify();
    expect(isErr(result) && result.error.kind).toBe("unauthorized");
  });

  it("throws when the repository URL cannot become an LFS endpoint", () => {
    expect(
      () =>
        new GitLfsLockProvider({
          repositoryUrl: "not-a-url",
          branch: () => "main",
          credential: fixedCredential(github("token")),
          http: async () => jsonResponse(200, {}),
        }),
    ).toThrow(/Invalid source-control repository URL/);
  });

  it("maps create 201 without a lock object to an http error", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async () => jsonResponse(201, { message: "ok" }),
    });
    const result = await provider.create("assets/hero.scene.hasset");
    expect(isErr(result) && result.error.kind).toBe("http");
    if (!isErr(result)) return;
    expect(result.error.message).toBe("create response missing lock");
    expect(result.error.status).toBe(201);
  });

  it("maps non-success create and unlock statuses to http errors", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
        if (request.url.endsWith("/unlock")) {
          return jsonResponse(500, { message: "unlock failed" });
        }
        return jsonResponse(422, { message: "path required" });
      },
    });
    const created = await provider.create("assets/hero.scene.hasset");
    expect(isErr(created) && created.error.kind).toBe("http");
    if (!isErr(created)) return;
    expect(created.error.message).toBe("path required");
    const unlocked = await provider.unlock("lock-1");
    expect(isErr(unlocked) && unlocked.error.kind).toBe("http");
    if (!isErr(unlocked)) return;
    expect(unlocked.error.message).toBe("unlock failed");
  });

  it("rejects a verify body that is not a JSON object and maps 403 to unauthorized", async () => {
    let bodyText = "";
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
        if (request.url.endsWith("/locks/verify")) return { status: 200, bodyText };
        return jsonResponse(403, { message: "forbidden" });
      },
    });
    for (const body of ["", "not json", "[{}]", '"locks"', '{"ours":{}}']) {
      bodyText = body;
      const verified = await provider.verify();
      expect(isErr(verified) && verified.error.kind).toBe("http");
    }
    const created = await provider.create("assets/a.hasset");
    expect(isErr(created) && created.error.kind).toBe("unauthorized");
    if (!isErr(created)) return;
    expect(created.error.status).toBe(403);
  });

  it("skips verify entries missing id or path and leaves a missing locked_at unknown", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async () =>
        jsonResponse(200, {
          ours: [
            sampleLock,
            { id: "", path: "assets/skip.hasset" },
            { id: "lock-2", path: "" },
            { not: "a lock" },
            { id: "lock-3", path: "assets/undated.hasset" },
          ],
        }),
    });
    const result = await provider.verify();
    expect(isOk(result) && result.value.ours.map(({ id, lockedAt }) => [id, lockedAt])).toEqual([
      ["lock-1", "2026-08-15T12:00:00Z"],
      ["lock-3", ""],
    ]);
  });

  it("treats 409 as conflict when verify cannot confirm the path is ours", async () => {
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://github.com/org/repo.git",
      branch: () => "main",
      credential: fixedCredential(github("token")),
      http: async (request) => {
        if (request.url.endsWith("/locks/verify")) {
          throw new Error("verify offline");
        }
        return jsonResponse(409, {
          lock: sampleLock,
          message: "already created lock",
        });
      },
    });
    const result = await provider.create("assets/hero.scene.hasset");
    expect(isErr(result) && result.error.kind).toBe("conflict");
    if (!isErr(result)) return;
    expect(result.error.lock?.ours).toBe(false);
  });

  it("sends the credential's own Basic username", async () => {
    const calls: HttpRequest[] = [];
    const gitlab: HostCredential = { origin: "https://gitlab.com", username: credentialUsername("gitlab"), token: "glo", kind: "gitlab" };
    const provider = new GitLfsLockProvider({
      repositoryUrl: "git@gitlab.com:group/game.git",
      branch: () => "main",
      credential: fixedCredential(gitlab),
      http: async (request) => {
        calls.push(request);
        return jsonResponse(200, { ours: [], theirs: [] });
      },
    });
    expect(isOk(await provider.verify())).toBe(true);
    expect(calls[0]?.url).toBe("https://gitlab.com/group/game.git/info/lfs/locks/verify");
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa("oauth2:glo")}`);
  });

  it("never sends a credential saved for another origin", async () => {
    let requests = 0;
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://gitea.example.com/org/repo",
      branch: () => "main",
      credential: fixedCredential(github("ghp_secret")),
      http: async () => {
        requests += 1;
        return jsonResponse(200, { ours: [], theirs: [] });
      },
    });
    const result = await provider.verify();
    expect(isErr(result) && result.error.kind).toBe("unauthorized");
    expect(requests).toBe(0);
  });

  it("reads a 404 or 501 from GitHub or GitLab as a repository the token cannot reach, never as missing lock support", async () => {
    for (const [repositoryUrl, credential] of [
      ["https://github.com/org/private", github("t")],
      ["https://gitlab.com/group/private", { origin: "https://gitlab.com", username: "oauth2", token: "t", kind: "gitlab" }],
      ["https://git.example.com/group/private", { origin: "https://git.example.com", username: "haptic", token: "t", kind: "gitlab-token" }],
    ] as const) {
      for (const status of [404, 501]) {
        const provider = new GitLfsLockProvider({
          repositoryUrl,
          branch: () => "main",
          credential: fixedCredential(credential),
          http: async () => jsonResponse(status, { message: "Not Found" }),
        });
        const verified = await provider.verify();
        expect(isErr(verified) && verified.error).toEqual({ kind: "http", message: "Repository Not Found Or No Access", status });
        const created = await provider.create("assets/a.hasset");
        expect(isErr(created) && created.error.kind).toBe("http");
      }
    }
  });

  it("renews the credential once after a 401 and retries with the new one", async () => {
    const tokens: string[] = [];
    let renewals = 0;
    const provider = new GitLfsLockProvider({
      repositoryUrl: "https://gitlab.com/group/game",
      branch: () => "main",
      credential: {
        current: async () => ({ origin: "https://gitlab.com", username: "oauth2", token: "old", kind: "gitlab" }),
        renew: async (refused) => {
          renewals += 1;
          return { ...refused, token: `new-${renewals}` };
        },
      },
      http: async (request) => {
        tokens.push(atob(request.headers.Authorization!.slice("Basic ".length)));
        return tokens.length === 1 ? jsonResponse(401, { message: "expired" }) : jsonResponse(200, { ours: [], theirs: [] });
      },
    });
    expect(isOk(await provider.verify())).toBe(true);
    expect(tokens).toEqual(["oauth2:old", "oauth2:new-1"]);
    // A second 401 is reported, not retried again.
    tokens.length = 0;
    const refusing = new GitLfsLockProvider({
      repositoryUrl: "https://gitlab.com/group/game",
      branch: () => "main",
      credential: { current: async () => ({ origin: "https://gitlab.com", username: "oauth2", token: "old", kind: "gitlab" }), renew: async (refused) => ({ ...refused, token: "new" }) },
      http: async (request) => {
        tokens.push(request.headers.Authorization!);
        return jsonResponse(401, { message: "revoked" });
      },
    });
    const refused = await refusing.verify();
    expect(isErr(refused) && refused.error.kind).toBe("unauthorized");
    expect(tokens).toHaveLength(2);
  });

  it("reads 404 and 501 from another host's create and verify as missing lock support, but an unlock 404 as an HTTP error", async () => {
    for (const status of [404, 501]) {
      const provider = new GitLfsLockProvider({
        repositoryUrl: "https://bitbucket.example.com/org/repo",
        branch: () => "main",
        credential: fixedCredential({ origin: "https://bitbucket.example.com", username: "x-access-token", token: "t", kind: "token" }),
        http: async () => jsonResponse(status, { message: "Not Found" }),
      });
      const verified = await provider.verify();
      expect(isErr(verified) && verified.error.kind).toBe("unsupported");
      const created = await provider.create("assets/a.hasset");
      expect(isErr(created) && created.error.kind).toBe("unsupported");
      const unlocked = await provider.unlock("lock-1");
      expect(isErr(unlocked) && unlocked.error.kind).toBe("http");
    }
  });
});
