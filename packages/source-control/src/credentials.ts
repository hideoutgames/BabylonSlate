import { originOf } from "./http";
import type { CommitAuthor } from "./sync-port";

export const GITHUB_ORIGIN = "https://github.com";
export const GITLAB_ORIGIN = "https://gitlab.com";
/** GitHub's REST API host: the one origin besides its own that a github.com credential reaches. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * How a credential was linked: `github` and `gitlab` by device sign-in,
 * `gitlab-token` as a self-managed GitLab token, `token` as any other host's.
 */
export type CredentialKind = "github" | "gitlab" | "gitlab-token" | "token";

/** One device credential for one HTTPS origin; never in `project.json` or Git. */
export interface HostCredential {
  origin: string;
  /** The Basic username Git and Git LFS send with the token. */
  username: string;
  token: string;
  kind: CredentialKind;
  /** The signed-in user's name, for sign-in kinds. */
  account?: string;
  /** The signed-in user's numeric id, for the host's no-reply commit email. */
  accountId?: string;
  /** GitLab sign-in tokens expire; the refresh token gets the next one. */
  refreshToken?: string;
  /** Clock time when `token` expires. */
  expiresAt?: number;
}

/** A fixed non-blank username: GitLab accepts any with a personal token. */
const GITLAB_TOKEN_USERNAME = "haptic";

export function credentialUsername(kind: CredentialKind): string {
  if (kind === "gitlab") return "oauth2";
  if (kind === "gitlab-token") return GITLAB_TOKEN_USERNAME;
  return "x-access-token";
}

/**
 * Who commits with a credential. A signed-in GitHub or gitlab.com account
 * commits as the host's private no-reply address, which the host links to
 * the account without exposing its email. Other hosts get no email.
 */
export function commitAuthorFor(credential: HostCredential | null): CommitAuthor {
  const name = credential?.account || "Haptic";
  const id = credential?.accountId;
  if (credential?.account && id && credential.kind === "github") return { name, email: `${id}+${credential.account}@users.noreply.github.com` };
  if (credential?.account && id && credential.kind === "gitlab") return { name, email: `${id}-${credential.account}@users.noreply.gitlab.com` };
  return { name, email: "" };
}

/** Whether the host has a REST API Haptic uses (repository and branch pickers, Release Pushed Locks). */
export function credentialHasHostApi(kind: CredentialKind): boolean {
  return kind !== "token";
}

/**
 * A credential goes only to the origin it was saved for. The one exception is
 * a github.com credential, which also reaches GitHub's REST API host.
 */
export function credentialAllowsOrigin(credential: Pick<HostCredential, "origin">, origin: string): boolean {
  return origin === credential.origin || (credential.origin === GITHUB_ORIGIN && origin === GITHUB_API_ORIGIN);
}

export class CredentialOriginError extends Error {
  constructor(url: string) {
    super(`A saved token is never sent to ${originOf(url) ?? "a non-HTTPS URL"}.`);
    this.name = "CredentialOriginError";
  }
}

export class NoCredentialError extends Error {
  constructor(url: string) {
    super(`Sign in to ${originOf(url) ? new URL(url).host : "the host"} first.`);
    this.name = "NoCredentialError";
  }
}

/** Where a request gets its credential, and a replacement after the host refuses it. */
export interface CredentialSource {
  current(): Promise<HostCredential | null>;
  /** A replacement for `refused` after a 401, or null when there is none. */
  renew(refused: HostCredential): Promise<HostCredential | null>;
}

/** A credential that is never renewed, such as one just returned by sign-in. */
export function fixedCredential(credential: HostCredential): CredentialSource {
  return { current: async () => credential, renew: async () => null };
}

function authorization(credential: HostCredential, scheme: "basic" | "bearer"): string {
  return scheme === "basic"
    ? `Basic ${btoa(`${credential.username}:${credential.token}`)}`
    : `Bearer ${credential.token}`;
}

/**
 * HTTP that adds the source's credential to each request, refuses any URL
 * outside its origin and never follows a redirect, so the token cannot reach
 * another host. A 401 renews the credential and retries once. Git and Git LFS
 * take Basic; REST APIs take Bearer. Any transport shaped like `HttpClient`
 * (the native file transfer) takes the same rule.
 */
export function authorizedHttp<
  Request extends { url: string; headers: Record<string, string>; disableRedirects?: boolean },
  Response extends { status: number },
>(source: CredentialSource, http: (request: Request) => Promise<Response>, scheme: "basic" | "bearer"): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const origin = originOf(request.url);
    let credential = await source.current();
    if (!credential) throw new NoCredentialError(request.url);
    for (let attempt = 0; ; attempt += 1) {
      if (!origin || !credentialAllowsOrigin(credential, origin)) throw new CredentialOriginError(request.url);
      const response = await http({
        ...request,
        headers: { ...request.headers, Authorization: authorization(credential, scheme) },
        disableRedirects: true,
      });
      if (response.status !== 401 || attempt > 0) return response;
      const renewed = await source.renew(credential);
      if (!renewed || renewed.token === credential.token) return response;
      credential = renewed;
    }
  };
}

/** The platform secret store, as `@haptic/vfs` `SecretStore` provides it. */
export interface SecretPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** All of the device's credentials live under one secret, so listing them is one read. */
export const CREDENTIALS_SECRET_KEY = "source-control:credentials";

const KINDS = new Set<CredentialKind>(["github", "gitlab", "gitlab-token", "token"]);

function parseCredentials(text: string | null): HostCredential[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byOrigin = new Map<string, HostCredential>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.origin !== "string" || originOf(value.origin) !== value.origin) continue;
    if (typeof value.token !== "string" || value.token === "") continue;
    if (typeof value.username !== "string" || value.username === "") continue;
    if (!KINDS.has(value.kind as CredentialKind)) continue;
    byOrigin.set(value.origin, {
      origin: value.origin,
      username: value.username,
      token: value.token,
      kind: value.kind as CredentialKind,
      ...(typeof value.account === "string" && value.account !== "" ? { account: value.account } : {}),
      ...(typeof value.accountId === "string" && /^\d+$/.test(value.accountId) ? { accountId: value.accountId } : {}),
      ...(typeof value.refreshToken === "string" && value.refreshToken !== "" ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    });
  }
  return [...byOrigin.values()];
}

/**
 * The device's credentials, one per HTTPS origin. Reads are cached after the
 * first. Every change re-reads the stored secret first, so another window's
 * write (a sign-in, a refreshed token) is never overwritten from a stale
 * cache, and changes are serialized within this process.
 */
export class CredentialStore {
  private readonly secrets: SecretPort;
  private cache: Promise<HostCredential[]> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(secrets: SecretPort) {
    this.secrets = secrets;
  }

  list(): Promise<HostCredential[]> {
    this.cache ??= this.read();
    return this.cache.then((credentials) => [...credentials]);
  }

  async get(origin: string): Promise<HostCredential | null> {
    return (await this.list()).find((credential) => credential.origin === origin) ?? null;
  }

  /** The stored credential as it is now, past the cache (another window may have changed it). */
  async reload(origin: string): Promise<HostCredential | null> {
    this.cache = this.read();
    return this.get(origin);
  }

  save(credential: HostCredential): Promise<void> {
    if (originOf(credential.origin) !== credential.origin) {
      return Promise.reject(new Error(`Not an HTTPS origin: ${credential.origin}`));
    }
    if (!credential.token) return Promise.reject(new Error("Enter a token."));
    return this.update(credential.origin, () => ({ ...credential })).then(() => undefined);
  }

  remove(origin: string): Promise<void> {
    return this.update(origin, () => null).then(() => undefined);
  }

  /**
   * Replaces one origin's credential with what `change` returns for the stored
   * one (null removes it), re-reading the secret first. Resolves to the result.
   */
  update(origin: string, change: (stored: HostCredential | null) => HostCredential | null): Promise<HostCredential | null> {
    const run = this.queue.then(async () => {
      const stored = await this.read();
      const current = stored.find((entry) => entry.origin === origin) ?? null;
      const next = change(current);
      const others = stored.filter((entry) => entry.origin !== origin);
      const written = next ? [...others, next] : others;
      await this.secrets.set(CREDENTIALS_SECRET_KEY, JSON.stringify(written));
      this.cache = Promise.resolve(written);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private read(): Promise<HostCredential[]> {
    const reading = this.secrets.get(CREDENTIALS_SECRET_KEY).then(parseCredentials);
    reading.catch(() => {
      if (this.cache === reading) this.cache = null;
    });
    return reading;
  }
}

/** A credential for a token pasted in Engine Settings. */
export function tokenCredential(origin: string, token: string, kind: "gitlab-token" | "token"): HostCredential {
  return { origin, username: credentialUsername(kind), token: token.trim(), kind };
}
