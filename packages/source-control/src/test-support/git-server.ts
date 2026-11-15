import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import type { ProjectStorage } from "@haptic/core";
import { fixedCredential, type HostCredential } from "../credentials";
import type { HttpClient, HttpRequest } from "../http";
import { lfsPointerText } from "../lfs-pointer";

/** The repository's origin as the code under test sees it; the test transport routes it to loopback. */
export const GIT_ORIGIN = "https://git.test";
/** Where LFS transfer actions point: another origin, with its own Authorization. */
export const STORAGE_ORIGIN = "https://lfs-storage.test";
export const REPOSITORY_URL = `${GIT_ORIGIN}/team/game.git`;
export const STORAGE_AUTHORIZATION = "RemoteAuth storage-token";

export const CREDENTIAL: HostCredential = {
  origin: GIT_ORIGIN,
  username: "x-access-token",
  token: "repository-token",
  kind: "token",
};

const EXPECTED_BASIC = `Basic ${Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.token}`).toString("base64")}`;

export interface RecordedRequest {
  origin: string;
  method: string;
  path: string;
  authorization: string | undefined;
  userAgent: string | undefined;
}

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A Git smart HTTP server (`git http-backend` as CGI, real protocol and
 * shallow support) with a Git LFS batch API, plus an LFS object store on a
 * second origin. Clients reach both through `http`, which routes the HTTPS
 * test origins to loopback, so the code under test keeps its HTTPS-only
 * credential rule. The repository requires the test credential; the store
 * requires the Authorization its batch actions name.
 */
export class GitTestServer {
  readonly root: string;
  readonly bare: string;
  readonly requests: RecordedRequest[] = [];
  /** LFS objects the store holds, by oid. */
  readonly objects = new Map<string, Uint8Array>();
  /** The batch API refuses these oids for download (as a server that lost them). */
  readonly unavailable = new Set<string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly servers: Server[] = [];
  private gitPort = 0;
  private storagePort = 0;
  private storages = 0;

  private constructor() {
    this.root = mkdtempSync(join(tmpdir(), "haptic-git-"));
    this.bare = join(this.root, "team", "game.git");
    const home = join(this.root, "home");
    mkdirSync(home, { recursive: true });
    const globalConfig = join(home, "gitconfig");
    writeFileSync(globalConfig, "");
    this.env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_AUTHOR_NAME: "Teammate",
      GIT_AUTHOR_EMAIL: "teammate@example.com",
      GIT_COMMITTER_NAME: "Teammate",
      GIT_COMMITTER_EMAIL: "teammate@example.com",
    };
  }

  static async start(): Promise<GitTestServer> {
    const server = new GitTestServer();
    mkdirSync(server.bare, { recursive: true });
    server.git(server.bare, "init", "--bare", "--quiet", "--initial-branch=main");
    server.git(server.bare, "config", "http.receivepack", "true");
    server.git(server.bare, "config", "uploadpack.allowFilter", "true");
    const git = createServer((request, response) => void server.serveGit(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    }));
    const storage = createServer((request, response) => void server.serveStorage(request, response));
    server.servers.push(git, storage);
    server.gitPort = await listen(git);
    server.storagePort = await listen(storage);
    return server;
  }

  async stop(): Promise<void> {
    await Promise.all(this.servers.map((server) => new Promise((resolve) => server.close(resolve))));
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Runs the system `git` with no system or user configuration. */
  git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env: this.env, encoding: "utf8", stdio: "pipe" });
  }

  /** A teammate's working copy, cloned with the system `git` straight from the bare repository. */
  teammate(): Teammate {
    const dir = join(this.root, `teammate-${this.servers.length}-${Math.random().toString(36).slice(2)}`);
    this.git(this.root, "clone", "--quiet", this.bare, dir);
    return new Teammate(this, dir);
  }

  /** Commits `files` to `main` as a teammate (LFS objects as pointers, their bytes in the store). */
  seed(files: Record<string, string | Uint8Array>, message = "Seed"): string {
    const teammate = this.teammate();
    teammate.write(files);
    return teammate.commitAndPush(message);
  }

  /** An empty project folder on disk, as the editor's storage binds it. */
  async storage(): Promise<ProjectStorage> {
    this.storages += 1;
    const storage = new NodeStorageAdapter(join(this.root, "devices"));
    await storage.openDocumentsProject(`project-${this.storages}`);
    return storage;
  }

  credential() {
    return fixedCredential(CREDENTIAL);
  }

  /** Native HTTP for tests: the HTTPS test origins go to the loopback servers over plain HTTP. */
  readonly http: HttpClient = async (request: HttpRequest) => {
    const url = new URL(request.url);
    const port = url.origin === GIT_ORIGIN ? this.gitPort : url.origin === STORAGE_ORIGIN ? this.storagePort : 0;
    if (!port) throw new TypeError(`fetch failed: ${url.origin} is unreachable`);
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
      redirect: request.disableRedirects ? "manual" : "follow",
    });
    const headers = Object.fromEntries(response.headers.entries());
    if (request.responseType === "binary") {
      return { status: response.status, bodyText: "", bodyBytes: new Uint8Array(await response.arrayBuffer()), headers };
    }
    return { status: response.status, bodyText: await response.text(), headers };
  };

  private record(origin: string, request: IncomingMessage): void {
    this.requests.push({ origin, method: request.method ?? "GET", path: request.url ?? "", authorization: request.headers.authorization, userAgent: request.headers["user-agent"] });
  }

  private async serveGit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.record(GIT_ORIGIN, request);
    if (request.headers.authorization !== EXPECTED_BASIC) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/team/game.git/info/lfs/objects/batch") {
      await this.batch(request, response);
      return;
    }
    await this.cgi(request, response, url);
  }

  private async cgi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const input = await body(request);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...this.env,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "tester",
        REQUEST_METHOD: request.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(input.byteLength),
        ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
      },
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdin.end(input);
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const raw = Buffer.concat(output);
    const split = raw.indexOf("\r\n\r\n");
    const headerEnd = split >= 0 ? split : raw.indexOf("\n\n");
    const separator = split >= 0 ? 4 : 2;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of raw.subarray(0, headerEnd).toString("latin1").split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.end(raw.subarray(headerEnd + separator));
  }

  private async batch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = JSON.parse((await body(request)).toString("utf8")) as { operation: string; objects: Array<{ oid: string; size: number }> };
    const objects = input.objects.map(({ oid, size }) => {
      const href = `${STORAGE_ORIGIN}/objects/${oid}`;
      const header = { Authorization: STORAGE_AUTHORIZATION };
      if (input.operation === "upload") {
        return this.objects.has(oid) ? { oid, size } : { oid, size, actions: { upload: { href, header } } };
      }
      if (!this.objects.has(oid) || this.unavailable.has(oid)) return { oid, size, error: { code: 404, message: "Object does not exist" } };
      return { oid, size, actions: { download: { href, header } } };
    });
    response.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" });
    response.end(JSON.stringify({ transfer: "basic", objects }));
  }

  private async serveStorage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.record(STORAGE_ORIGIN, request);
    const oid = /^\/objects\/([0-9a-f]{64})$/.exec(request.url ?? "")?.[1];
    if (!oid || request.headers.authorization !== STORAGE_AUTHORIZATION) {
      response.writeHead(oid ? 401 : 404);
      response.end();
      return;
    }
    if (request.method === "PUT") {
      const bytes = await body(request);
      if (sha256(bytes) !== oid) {
        response.writeHead(422);
        response.end();
        return;
      }
      this.objects.set(oid, new Uint8Array(bytes));
      response.writeHead(200);
      response.end();
      return;
    }
    const bytes = this.objects.get(oid);
    response.writeHead(bytes ? 200 : 404, { "Content-Type": "application/octet-stream" });
    response.end(bytes ? Buffer.from(bytes) : undefined);
  }
}

/** A teammate's clone, driven by the system `git`. */
export class Teammate {
  constructor(
    private readonly server: GitTestServer,
    readonly dir: string,
  ) {}

  /** Writes files; a `Uint8Array` under `.blobs/` becomes a pointer, with its bytes put in the LFS store. */
  write(files: Record<string, string | Uint8Array>): void {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.dir, path);
      mkdirSync(dirname(target), { recursive: true });
      if (content instanceof Uint8Array && /\.blobs\/[0-9a-f]{64}$/.test(path)) {
        this.server.objects.set(sha256(content), content);
        writeFileSync(target, lfsPointerText(sha256(content), content.byteLength));
      } else {
        writeFileSync(target, content);
      }
    }
  }

  remove(...paths: string[]): void {
    for (const path of paths) rmSync(join(this.dir, path));
  }

  commitAndPush(message: string): string {
    this.server.git(this.dir, "add", "--all");
    this.server.git(this.dir, "commit", "--quiet", "-m", message);
    this.server.git(this.dir, "push", "--quiet", "origin", "HEAD:main");
    return this.server.git(this.dir, "rev-parse", "HEAD").trim();
  }

  pull(): void {
    this.server.git(this.dir, "pull", "--quiet", "--ff-only", "origin", "main");
  }
}

/** Bytes for an LFS object of `size`, deterministic per `seed`. */
export function blobBytes(seed: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed * 2654435761;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

export function blobPath(bytes: Uint8Array, folder = "assets"): string {
  return `${folder}/.blobs/${sha256(bytes)}`;
}

/** Storage that records every full read, so a test can see which files an operation opened. */
export function countingStorage(storage: ProjectStorage): { storage: ProjectStorage; reads: string[] } {
  const reads: string[] = [];
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if ((property === "readBinary" || property === "readText") && typeof value === "function") {
        return (path: string, ...rest: unknown[]) => {
          reads.push(path);
          return (value as (...args: unknown[]) => unknown).call(target, path, ...rest);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { storage: proxy, reads };
}
