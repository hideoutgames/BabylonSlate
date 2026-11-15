import { isOk, type ProjectStorage } from "@haptic/core";
import type { CredentialSource, HostCredential, HttpClient } from "@haptic/source-control";
import { hostApiFor } from "@haptic/source-control/host-api";
import { pushedPaths } from "@haptic/source-control/pushed-locks";

/**
 * Release Pushed Locks' check, loaded on first use: one remote tree read for
 * the wanted paths, then each local file hashed once. Lock paths are
 * repository-relative and the project folder is the repository root.
 */
export async function pushedLockPaths(input: {
  credential: HostCredential;
  source: CredentialSource;
  http: HttpClient;
  repositoryPath: string;
  branch: string;
  paths: readonly string[];
  storage: ProjectStorage;
}): Promise<ReadonlySet<string>> {
  if (input.paths.length === 0) return new Set();
  const api = hostApiFor(input.credential, input.http, input.source);
  if (!api) throw new Error("This host has no API to compare pushed files.");
  const remote = await api.blobIds(input.repositoryPath, input.branch, new Set(input.paths));
  if (!isOk(remote)) throw new Error(remote.error.message);
  const { storage } = input;
  return pushedPaths(input.paths, remote.value, {
    read: (path) => storage.readBinary(path).catch(() => null),
    size: (path) => storage.stat(path).then((stat) => (stat.isDir ? null : stat.size), () => null),
  });
}
