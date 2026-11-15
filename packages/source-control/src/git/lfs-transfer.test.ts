import { describe, expect, it } from "vitest";
import { fixedCredential } from "../credentials";
import type { HttpRequest, HttpResponse } from "../http";
import { isSyncError, type SyncError } from "../sync-port";
import { LfsTransfer } from "./lfs-transfer";

const CREDENTIAL = { origin: "https://git.example", username: "x-access-token", token: "secret", kind: "token" as const };
const BASIC = `Basic ${btoa("x-access-token:secret")}`;
const BYTES = new TextEncoder().encode("abc");
/** `sha256sum` of "abc". */
const OID = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const OBJECT = { oid: OID, size: 3 };

function host(batch: (operation: string) => unknown, transfers: (request: HttpRequest) => HttpResponse = () => ({ status: 200, bodyText: "" })) {
  const requests: HttpRequest[] = [];
  const lfs = new LfsTransfer({
    repositoryUrl: "https://git.example/team/game.git",
    branch: "main",
    credential: fixedCredential(CREDENTIAL),
    http: async (request) => {
      requests.push(request);
      if (request.url === "https://git.example/team/game.git/info/lfs/objects/batch") {
        const body = JSON.parse(request.body as string) as { operation: string };
        return { status: 200, bodyText: JSON.stringify(batch(body.operation)) };
      }
      return transfers(request);
    },
  });
  return { lfs, requests };
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(isSyncError(error)).toBe(true);
  return error as SyncError;
}

describe("LfsTransfer", () => {
  it("adds the stored credential to an action on the repository's origin only when the action brings none", async () => {
    const { lfs, requests } = host(() => ({
      objects: [{
        ...OBJECT,
        actions: {
          upload: { href: "https://git.example/team/game.git/lfs/objects/abc" },
          verify: { href: "https://verify.example/check", header: { "X-Verify": "1" } },
        },
      }],
    }));
    expect(await lfs.upload([OBJECT, OBJECT], async () => BYTES)).toBe(1);
    expect(requests.map((request) => [request.method, request.url, request.headers.Authorization ?? null, request.disableRedirects ?? false])).toEqual([
      ["POST", "https://git.example/team/game.git/info/lfs/objects/batch", BASIC, true],
      ["PUT", "https://git.example/team/game.git/lfs/objects/abc", BASIC, true],
      ["POST", "https://verify.example/check", null, true],
    ]);
    expect(requests[1]!.body).toBe(BYTES);
    expect(requests[2]!.headers["X-Verify"]).toBe("1");
    expect(JSON.parse(requests[0]!.body as string)).toEqual({
      operation: "upload",
      transfers: ["basic"],
      ref: { name: "refs/heads/main" },
      objects: [OBJECT],
      hash_algo: "sha256",
    });
  });

  it("uses an action's own Authorization, even on the repository's origin", async () => {
    const { lfs, requests } = host(() => ({
      objects: [{ ...OBJECT, actions: { download: { href: "https://git.example/objects/abc", header: { Authorization: "Bearer temporary" } } } }],
    }), () => ({ status: 200, bodyText: "", bodyBytes: BYTES }));
    const written: Uint8Array[] = [];
    await lfs.download([OBJECT], async (_object, bytes) => {
      written.push(bytes);
    });
    expect(written).toEqual([BYTES]);
    expect(requests[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer temporary" }, responseType: "binary", disableRedirects: true });
  });

  // GitLab's upload actions name `Transfer-Encoding: chunked`; the body goes whole, so framing is the transport's.
  it("sends an action's headers in place of its own, whatever their case, but never the transport's framing", async () => {
    const { lfs, requests } = host(() => ({
      objects: [{
        ...OBJECT,
        actions: { upload: { href: "https://cdn.example/a", header: { authorization: "Basic action", "content-type": "application/x-custom", "Transfer-Encoding": "chunked", "Content-Length": "999" } } },
      }],
    }));
    await lfs.upload([OBJECT], async () => BYTES);
    expect(requests[1]!.headers).toEqual({ authorization: "Basic action", "content-type": "application/x-custom" });
  });

  it("refuses a damaged download, an object the server lacks and a transfer address that is not HTTPS", async () => {
    const download = (actions: unknown, bodyBytes = BYTES) =>
      host(() => ({ objects: [{ ...OBJECT, actions }] }), () => ({ status: 200, bodyText: "", bodyBytes })).lfs.download([OBJECT], async () => {});
    expect((await failure(download({ download: { href: "https://cdn.example/a" } }, new TextEncoder().encode("abd")))).code).toBe("lfs-object-corrupt");
    expect((await failure(download({ download: { href: "https://cdn.example/a" } }, new Uint8Array(2)))).code).toBe("lfs-object-corrupt");
    expect((await failure(download({}))).code).toBe("lfs-object-missing");
    expect((await failure(download({ download: { href: "http://cdn.example/a" } }))).kind).toBe("lfs");
    const missing = host(() => ({ objects: [{ ...OBJECT, error: { code: 404, message: "Object does not exist" } }] }));
    expect((await failure(missing.lfs.download([OBJECT], async () => {}))).code).toBe("lfs-object-missing");
  });

  it("types a refused batch and a failed transfer", async () => {
    const refused = new LfsTransfer({
      repositoryUrl: "https://git.example/team/game.git",
      branch: "main",
      credential: fixedCredential(CREDENTIAL),
      http: async () => ({ status: 403, bodyText: "" }),
    });
    expect((await failure(refused.upload([OBJECT], async () => BYTES))).kind).toBe("auth");
    const { lfs } = host(() => ({ objects: [{ ...OBJECT, actions: { upload: { href: "https://cdn.example/a" } } }] }), () => ({ status: 500, bodyText: "" }));
    expect(await failure(lfs.upload([OBJECT], async () => BYTES))).toMatchObject({ kind: "lfs", status: 500 });
    const offline = new LfsTransfer({
      repositoryUrl: "https://git.example/team/game.git",
      branch: "main",
      credential: fixedCredential(CREDENTIAL),
      http: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect((await failure(offline.download([OBJECT], async () => {}))).kind).toBe("network");
  });
});
