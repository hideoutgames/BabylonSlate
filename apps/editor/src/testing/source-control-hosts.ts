import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type SourceControlProjectSettings } from "@haptic/core";
import type { HostCredential, HttpClient } from "@haptic/source-control";
import { MemorySecrets } from "@haptic/source-control/fake-host";
import { SourceControlAccounts } from "../services/source-control-accounts";

/**
 * Manual mode on a GitHub repository, which {@link signedInHosts} holds a
 * credential for, locking each edited file at once (Lock On Edit Always).
 */
export const MANUAL_SOURCE_CONTROL: SourceControlProjectSettings = {
  ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  mode: "manual",
  repositoryUrl: "https://github.com/org/repo",
  lockOnEdit: "always",
};

export const TEST_GITHUB_CREDENTIAL: HostCredential = {
  origin: "https://github.com",
  username: "x-access-token",
  token: "fake-gh",
  kind: "github",
  account: "ada",
};

/** The real device accounts over in-memory secrets, signed in to GitHub unless told otherwise. */
export async function signedInHosts(
  http: HttpClient | null = null,
  credential: HostCredential | null = TEST_GITHUB_CREDENTIAL,
): Promise<SourceControlAccounts> {
  const accounts = new SourceControlAccounts(new MemorySecrets(), http);
  if (credential) await accounts.save(credential);
  return accounts;
}
