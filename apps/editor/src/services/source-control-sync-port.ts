import type { ProjectStorage } from "@haptic/core";
import {
  commitAuthorFor,
  parseRepositoryUrl,
  repositoryCloneUrl,
  type FileTransferClient,
  type HttpClient,
  type SyncPort,
  type TransferOptions,
} from "@haptic/source-control";
import type { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { createNativeFileTransfer, folderFileTransfer } from "@haptic/vfs";
import { folderBoundStorage } from "../lib/folder-bound-storage";
import { sourceControlAccounts } from "./source-control-accounts";
import type { SyncPortFactory, SyncPortRequest, TransferMonitor } from "./source-control-sync";

/**
 * Integrated mode's Git client for a project folder, loaded only for an
 * Integrated project, Clone or Publish: the Git core (isomorphic-git) on iOS,
 * Android and desktop with the device's credential for the repository's
 * host, and in test mode `FakeSync` over remotes kept in memory for the page.
 */

function byteLength(body: string | Uint8Array | undefined): number {
  if (body === undefined) return 0;
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

/** Native HTTP that reports each request's bytes. */
export function monitoredHttp(http: HttpClient, monitor: TransferMonitor): HttpClient {
  return async (request) => {
    const response = await http(request);
    monitor.bytes(byteLength(request.body) + (response.bodyBytes?.byteLength ?? byteLength(response.bodyText)));
    return response;
  };
}

/**
 * The native file transfer that reports the bytes it moves as they stream
 * (each request's progress, then whatever its answer adds), so a large LFS
 * object counts up rather than landing at once.
 */
export function monitoredFiles(files: FileTransferClient, monitor: TransferMonitor): FileTransferClient {
  return async (request) => {
    let reported = 0;
    const report = (bytes: number) => {
      if (bytes <= reported) return;
      monitor.bytes(bytes - reported);
      reported = bytes;
    };
    const response = await files({
      ...request,
      onProgress: (bytes) => {
        report(bytes);
        request.onProgress?.(bytes);
      },
    });
    report(response.bytes);
    return response;
  };
}

/**
 * The host's native file transfer for the folder `storage` is bound to (a
 * folder-bound view refuses it once another project is open), or none on a
 * host without one, where LFS objects cross whole through native HTTP.
 */
function deviceFileTransfer(storage: ProjectStorage): FileTransferClient | null {
  const native = createNativeFileTransfer();
  if (!native) return null;
  const bound = folderFileTransfer(native, storage);
  return (request) => bound.transfer(request);
}

/** Test mode: one fake remote per repository and one working copy per folder, for the page's lifetime. */
const testRemotes = new Map<string, FakeRemote>();
const testCopies = new Map<string, FakeSync>();

function remoteKey(repositoryUrl: string): string {
  const location = parseRepositoryUrl(repositoryUrl);
  return location ? repositoryCloneUrl(location) : repositoryUrl.trim();
}

/** The fake remote behind a repository URL in test mode, created empty on first use; tests commit to it as a teammate. */
export async function testRemote(repositoryUrl: string): Promise<FakeRemote> {
  const key = remoteKey(repositoryUrl);
  let remote = testRemotes.get(key);
  if (!remote) {
    const { FakeRemote } = await import("@haptic/source-control/fake-sync");
    remote = new FakeRemote();
    testRemotes.set(key, remote);
  }
  return remote;
}

/** A folder's working copy keeps its own branch, as its `.git/HEAD` does on a device. */
function copyKey(request: Pick<SyncPortRequest, "folderId" | "repositoryUrl">): string {
  return [request.folderId, remoteKey(request.repositoryUrl)].join("\n");
}

/** The Git core and its options for the folder; a copy that exists opens on the branch its HEAD names. */
async function deviceRepository(request: SyncPortRequest) {
  const location = parseRepositoryUrl(request.repositoryUrl);
  if (!location) throw new Error(`Invalid repository URL: ${request.repositoryUrl}`);
  const accounts = await sourceControlAccounts(false);
  if (!accounts.http) throw new Error("Source control is not available on this device.");
  const files = deviceFileTransfer(request.storage);
  return {
    git: await import("@haptic/source-control/git"),
    options: {
      storage: request.storage,
      http: monitoredHttp(accounts.http, request.transfer),
      ...(files ? { files: monitoredFiles(files, request.transfer) } : {}),
      credential: accounts.credentialSource(location.origin),
      repositoryUrl: request.repositoryUrl,
    },
  };
}

export const syncPortFactory: SyncPortFactory = {
  async open(request) {
    if (request.testMode) {
      const key = copyKey(request);
      const existing = testCopies.get(key);
      if (existing) return existing;
      const { FakeSync } = await import("@haptic/source-control/fake-sync");
      const copy = new FakeSync({ storage: request.storage, remote: await testRemote(request.repositoryUrl), branch: request.branch });
      testCopies.set(key, copy);
      return copy;
    }
    const { git, options } = await deviceRepository(request);
    return git.openRepository(options);
  },
  async init(request) {
    if (request.testMode) {
      const { FakeSync } = await import("@haptic/source-control/fake-sync");
      const copy = FakeSync.init({ storage: request.storage, remote: await testRemote(request.repositoryUrl), branch: request.branch });
      testCopies.set(copyKey(request), copy);
      return copy;
    }
    const { git, options } = await deviceRepository(request);
    return git.initRepository({ ...options, branch: request.branch, replace: request.replace });
  },
  async author(repositoryUrl, testMode) {
    const location = parseRepositoryUrl(repositoryUrl);
    if (!location) return commitAuthorFor(null);
    const accounts = await sourceControlAccounts(testMode);
    return commitAuthorFor(await accounts.credentialSource(location.origin).current());
  },
  // The working copy's own Git config: no credential or network.
  async readAdoption(storage) {
    return (await import("@haptic/source-control/git")).readAdoption(storage);
  },
  async setAdoption(storage, adopted) {
    await (await import("@haptic/source-control/git")).setAdoption(storage, adopted);
  },
};

/**
 * Clone: the repository's branch into the empty project folder `storage` is
 * bound to. Its working copy then opens through `syncPortFactory.open`. A
 * cancel through `signal` rejects with a `cancelled` `SyncError`.
 */
export async function cloneIntoFolder(request: SyncPortRequest & TransferOptions): Promise<SyncPort> {
  const signal = request.signal ? { signal: request.signal } : {};
  // Test mode keeps this copy and `open` hands it out again: like every port, it works on its own folder only.
  const bound = { ...request, storage: folderBoundStorage(request.storage, request.folderId) };
  if (request.testMode) {
    const { FakeSync } = await import("@haptic/source-control/fake-sync");
    const copy = await FakeSync.clone({ storage: bound.storage, remote: await testRemote(request.repositoryUrl), branch: request.branch, ...signal });
    testCopies.set(copyKey(request), copy);
    return copy;
  }
  const { git, options } = await deviceRepository(bound);
  return git.cloneRepository({ ...options, branch: request.branch, ...signal });
}
