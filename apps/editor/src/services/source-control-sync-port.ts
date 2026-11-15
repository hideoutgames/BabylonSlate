import {
  parseRepositoryUrl,
  repositoryCloneUrl,
  type CommitAuthor,
  type HostCredential,
  type HttpClient,
  type SyncPort,
} from "@haptic/source-control";
import type { FakeRemote, FakeSync } from "@haptic/source-control/fake-sync";
import { sourceControlAccounts } from "./source-control-accounts";
import type { SyncPortFactory, SyncPortRequest, TransferMonitor } from "./source-control-sync";

/**
 * Integrated mode's Git client for a project folder, loaded only for an
 * Integrated project, Clone or Publish: the Git core (isomorphic-git) on iOS,
 * Android and desktop with the device's credential for the repository's
 * host, and in test mode `FakeSync` over remotes kept in memory for the page.
 */

/** A transfer the user cancelled: the request after the cancel is refused. */
export class TransferCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "TransferCancelledError";
  }
}

function byteLength(body: string | Uint8Array | undefined): number {
  if (body === undefined) return 0;
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

/** Native HTTP that reports each request's bytes and refuses requests once the operation is cancelled. */
export function monitoredHttp(http: HttpClient, monitor: TransferMonitor): HttpClient {
  return async (request) => {
    if (monitor.signal()?.aborted) throw new TransferCancelledError();
    const response = await http(request);
    monitor.bytes(byteLength(request.body) + (response.bodyBytes?.byteLength ?? byteLength(response.bodyText)));
    if (monitor.signal()?.aborted) throw new TransferCancelledError();
    return response;
  };
}

/**
 * Who commits from this device: the host account the credential belongs to.
 * Hosts accept an empty email; Haptic does not guess an address.
 */
export function commitAuthorFor(credential: HostCredential | null): CommitAuthor {
  return { name: credential?.account || "Haptic", email: "" };
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

function copyKey(request: Pick<SyncPortRequest, "folderId" | "repositoryUrl" | "branch">): string {
  return [request.folderId, remoteKey(request.repositoryUrl), request.branch].join("\n");
}

async function deviceRepository(request: SyncPortRequest) {
  const location = parseRepositoryUrl(request.repositoryUrl);
  if (!location) throw new Error(`Invalid repository URL: ${request.repositoryUrl}`);
  const accounts = await sourceControlAccounts(false);
  if (!accounts.http) throw new Error("Source control is not available on this device.");
  return {
    git: await import("@haptic/source-control/git"),
    options: {
      storage: request.storage,
      http: monitoredHttp(accounts.http, request.transfer),
      credential: accounts.credentialSource(location.origin),
      repositoryUrl: request.repositoryUrl,
      branch: request.branch,
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
    return git.initRepository(options);
  },
  async author(repositoryUrl, testMode) {
    const location = parseRepositoryUrl(repositoryUrl);
    if (!location) return commitAuthorFor(null);
    const accounts = await sourceControlAccounts(testMode);
    return commitAuthorFor(await accounts.credentialSource(location.origin).current());
  },
};

/**
 * Clone: the repository's branch into the empty project folder `storage` is
 * bound to. Its working copy then opens through `syncPortFactory.open`.
 */
export async function cloneIntoFolder(request: SyncPortRequest): Promise<SyncPort> {
  if (request.testMode) {
    const { FakeSync } = await import("@haptic/source-control/fake-sync");
    if (request.transfer.signal()?.aborted) throw new TransferCancelledError();
    const copy = await FakeSync.clone({ storage: request.storage, remote: await testRemote(request.repositoryUrl), branch: request.branch });
    testCopies.set(copyKey(request), copy);
    return copy;
  }
  const { git, options } = await deviceRepository(request);
  return git.cloneRepository(options);
}
