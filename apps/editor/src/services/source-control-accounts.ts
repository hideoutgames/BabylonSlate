import { isOk } from "@haptic/core";
import {
  credentialHasHostApi,
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

/**
 * Whether a saved credential still works as far as this device knows:
 * `refused` once its host answered it with a 401 that no refresh replaced,
 * `expired` past an expiry nothing can renew (a GitHub App's user token).
 */
export type SignInState = "signed-in" | "refused" | "expired";

export class SourceControlAccounts implements SourceControlHosts {
  readonly http: HttpClient | null;
  readonly fakeHost: FakeGitHost | null;
  private readonly store: CredentialStore;
  private readonly refreshing: RefreshingCredentials | null;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  /** The token its host refused, by origin: a credential is refused only while it still holds that token. */
  private readonly refusedTokens = new Map<string, string>();
  /** Origin and token pairs asked about this session. */
  private readonly checked = new Set<string>();

  constructor(secrets: SecretPort, http: HttpClient | null, options: SourceControlAccountsOptions = {}) {
    this.store = new CredentialStore(secrets);
    this.http = http;
    this.fakeHost = options.fakeHost ?? null;
    this.now = options.now ?? Date.now;
    this.refreshing = http
      ? new RefreshingCredentials({
          store: this.store,
          http,
          now: this.now,
          clientId: options.clientId ?? (() => null),
          onChange: () => this.emit(),
          onRefused: (origin, credential) => this.markRefused(origin, credential.token),
        })
      : null;
  }

  list(): Promise<HostCredential[]> {
    return this.store.list();
  }

  credentialSource(origin: string): CredentialSource {
    return this.refreshing?.source(origin) ?? {
      current: () => this.store.get(origin),
      renew: async () => null,
      refused: (credential) => this.markRefused(origin, credential.token),
    };
  }

  signInState(credential: HostCredential): SignInState {
    if (this.refusedTokens.get(credential.origin) === credential.token) return "refused";
    // A GitLab sign-in refreshes itself; only an expiry without a refresh token is final.
    if (credential.expiresAt !== undefined && credential.refreshToken === undefined && credential.expiresAt <= this.now()) return "expired";
    return "signed-in";
  }

  /**
   * Asks the origin's host who its saved credential signs in as, once per
   * credential each session (one request; a host with no API, an expired
   * sign-in or no credential asks nothing). A refusal is recorded through the
   * credential source; an answer clears an earlier one; an unreachable host
   * changes nothing. Never rejects.
   */
  async checkSignIn(origin: string): Promise<void> {
    try {
      const credential = await this.credentialSource(origin).current();
      if (!credential || !this.http || !credentialHasHostApi(credential.kind) || this.signInState(credential) === "expired") return;
      const key = `${origin}\n${credential.token}`;
      if (this.checked.has(key)) return;
      this.checked.add(key);
      const { hostApiFor } = await import("@haptic/source-control/host-api");
      const result = await hostApiFor(credential, this.http, this.credentialSource(origin))?.user();
      if (result && isOk(result) && this.refusedTokens.get(origin) === credential.token) {
        this.refusedTokens.delete(origin);
        this.emit();
      }
    } catch {
      // The store or the host could not answer: nothing is known.
    }
  }

  /** `checkSignIn` for every saved credential. */
  async checkSignIns(): Promise<void> {
    const credentials = await this.list().catch(() => []);
    await Promise.all(credentials.map((credential) => this.checkSignIn(credential.origin)));
  }

  private markRefused(origin: string, token: string): void {
    if (this.refusedTokens.get(origin) === token) return;
    this.refusedTokens.set(origin, token);
    this.emit();
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
