import {
  CredentialStore,
  type CredentialKind,
  type CredentialSource,
  type HostCredential,
  type HttpClient,
  type SecretPort,
} from "@haptic/source-control";
import type { FakeGitHost } from "@haptic/source-control/fake-host";
import { RefreshingCredentials } from "@haptic/source-control/token-refresh";
import { createNativeHttp, createSecretStore } from "@haptic/vfs";
import { deviceClientId } from "../lib/source-control-client-ids";
import type { SourceControlHosts } from "./source-control-service";

/**
 * The device's Source Control credentials (one per host origin) and native
 * HTTP, shared by Engine Settings, Project Settings and the open project's
 * locks. Loaded only when something needs them: a project whose mode is not
 * Off, or the Source Control settings pages. Test mode keeps credentials in
 * memory and talks to the fake GitHub and GitLab host.
 */
export interface SourceControlAccountsOptions {
  /** Test mode's GitHub and GitLab, for test hooks to script. */
  fakeHost?: FakeGitHost | null;
  /** The public client id a sign-in kind refreshes with. */
  clientId?: (kind: CredentialKind) => string | null;
  now?: () => number;
}

export class SourceControlAccounts implements SourceControlHosts {
  readonly http: HttpClient | null;
  readonly fakeHost: FakeGitHost | null;
  private readonly store: CredentialStore;
  private readonly refreshing: RefreshingCredentials | null;
  private readonly listeners = new Set<() => void>();

  constructor(secrets: SecretPort, http: HttpClient | null, options: SourceControlAccountsOptions = {}) {
    this.store = new CredentialStore(secrets);
    this.http = http;
    this.fakeHost = options.fakeHost ?? null;
    this.refreshing = http
      ? new RefreshingCredentials({
          store: this.store,
          http,
          now: options.now ?? Date.now,
          clientId: options.clientId ?? (() => null),
          onChange: () => this.emit(),
        })
      : null;
  }

  list(): Promise<HostCredential[]> {
    return this.store.list();
  }

  credentialSource(origin: string): CredentialSource {
    return this.refreshing?.source(origin) ?? { current: () => this.store.get(origin), renew: async () => null };
  }


  async save(credential: HostCredential): Promise<void> {
    await this.store.save(credential);
    this.emit();
  }

  async remove(origin: string): Promise<void> {
    await this.store.remove(origin);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

let shared: Promise<SourceControlAccounts> | null = null;

export function sourceControlAccounts(testMode: boolean): Promise<SourceControlAccounts> {
  const clientId = (kind: CredentialKind) => (kind === "gitlab" ? deviceClientId("gitlab", testMode) : null);
  shared ??= (async () => {
    if (!testMode) return new SourceControlAccounts(createSecretStore(), createNativeHttp(), { clientId });
    const { FakeGitHost, MemorySecrets } = await import("@haptic/source-control/fake-host");
    const fakeHost = new FakeGitHost();
    return new SourceControlAccounts(new MemorySecrets(), fakeHost.http, { fakeHost, clientId });
  })();
  return shared;
}
