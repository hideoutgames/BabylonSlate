import type { CredentialKind, CredentialSource, CredentialStore, HostCredential } from "./credentials";
import { errorMessage, formBody, parseJsonObject, stringField, type HttpClient } from "./http";

/** Refresh this long before a token expires, so a request never carries one about to lapse. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

/** Only GitLab sign-in tokens expire; a non-confidential app refreshes them with its client id alone. */
const REFRESHING_KINDS = new Set<CredentialKind>(["gitlab"]);

export interface RefreshingCredentialsOptions {
  store: CredentialStore;
  http: HttpClient;
  now: () => number;
  /** The public client id a sign-in kind refreshes with; null when the build has none. */
  clientId: (kind: CredentialKind) => string | null;
  /** After a refresh replaced or removed a credential. */
  onChange?: () => void;
  /** The host refused a credential of `origin` that no refresh replaced (`CredentialSource.refused`). */
  onRefused?: (origin: string, credential: HostCredential) => void;
}

interface RefreshedToken {
  token: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

function needsRefresh(credential: HostCredential, now: number): boolean {
  return credential.refreshToken !== undefined && credential.expiresAt !== undefined &&
    credential.expiresAt - REFRESH_MARGIN_MS <= now;
}

/**
 * Credentials that refresh themselves: shortly before a GitLab sign-in token
 * expires, and once when the host refuses it with a 401. One refresh per
 * origin is in flight at a time. A refresh the host rejects signs the host
 * out (the credential is removed, unless another window refreshed it
 * meanwhile); a refresh that cannot reach the host keeps the credential and
 * fails the request.
 */
export class RefreshingCredentials {
  private readonly options: RefreshingCredentialsOptions;
  private readonly inflight = new Map<string, Promise<HostCredential | null>>();

  constructor(options: RefreshingCredentialsOptions) {
    this.options = options;
  }

  source(origin: string): CredentialSource {
    return {
      current: () => this.current(origin),
      renew: (refused) => this.refresh(origin, refused),
      refused: (credential) => this.options.onRefused?.(origin, credential),
    };
  }

  async current(origin: string): Promise<HostCredential | null> {
    const credential = await this.options.store.get(origin);
    return credential && needsRefresh(credential, this.options.now()) ? this.refresh(origin, credential) : credential;
  }

  private refresh(origin: string, stale: HostCredential): Promise<HostCredential | null> {
    let pending = this.inflight.get(origin);
    if (!pending) {
      pending = this.run(origin, stale).finally(() => this.inflight.delete(origin));
      this.inflight.set(origin, pending);
    }
    return pending;
  }

  private async run(origin: string, stale: HostCredential): Promise<HostCredential | null> {
    const { store, now, clientId, onChange } = this.options;
    // Another window may already have refreshed it, which spent the old refresh token.
    const stored = await store.reload(origin);
    if (!stored) return null;
    if (stored.token !== stale.token && !needsRefresh(stored, now())) return stored;
    // Only a GitLab sign-in has a replacement; any other refused credential keeps its 401.
    if (!stored.refreshToken || !REFRESHING_KINDS.has(stored.kind)) return null;
    const id = clientId(stored.kind);
    const refreshed = id ? await this.request(stored, id) : null;
    // Only the credential this refresh started from is replaced or removed.
    const same = (current: HostCredential | null) => current?.refreshToken === stored.refreshToken;
    const result = await store.update(origin, (current) => {
      if (!same(current)) return current;
      if (!refreshed) return null;
      const next: HostCredential = { ...stored, token: refreshed.token, refreshToken: refreshed.refreshToken ?? stored.refreshToken };
      if (refreshed.expiresIn === null) delete next.expiresAt;
      else next.expiresAt = now() + refreshed.expiresIn * 1000;
      return next;
    });
    onChange?.();
    return result;
  }

  /** The new token, or null when the host rejects the refresh; throws when the host cannot answer. */
  private async request(credential: HostCredential, clientId: string): Promise<RefreshedToken | null> {
    const host = new URL(credential.origin).host;
    let response;
    try {
      response = await this.options.http({
        method: "POST",
        url: `${credential.origin}/oauth/token`,
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({ grant_type: "refresh_token", refresh_token: credential.refreshToken!, client_id: clientId }),
        disableRedirects: true,
      });
    } catch (error) {
      throw new Error(`Could not refresh the ${host} sign-in: ${errorMessage(error)}`, { cause: error });
    }
    if (response.status >= 500) throw new Error(`Could not refresh the ${host} sign-in: HTTP ${response.status}`);
    const json = parseJsonObject(response.bodyText);
    const token = stringField(json, "access_token");
    if (response.status !== 200 || !token) return null;
    const expiresIn = json?.expires_in;
    return {
      token,
      refreshToken: stringField(json, "refresh_token"),
      expiresIn: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : null,
    };
  }
}
