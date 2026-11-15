import { err, isOk, ok, type Result } from "@haptic/core";
import {
  authorizedHttp,
  fixedCredential,
  credentialUsername,
  GITHUB_ORIGIN,
  GITLAB_ORIGIN,
  type HostCredential,
} from "./credentials";
import { errorMessage, formBody, parseJsonObject, stringField, type HttpClient, type HttpResponse } from "./http";

/** Hosts that offer OAuth device sign-in with a public client (no client secret). */
export type DeviceSignInHost = "github" | "gitlab";

interface DeviceHost {
  origin: string;
  label: string;
  codeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Opened in the system browser; the response's own URL is never trusted. */
  verificationUrl: string;
  userUrl: string;
  userAccept: string;
  accountField: string;
}

export const DEVICE_SIGN_IN_HOSTS: Record<DeviceSignInHost, DeviceHost> = {
  github: {
    origin: GITHUB_ORIGIN,
    label: "GitHub",
    codeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo",
    verificationUrl: "https://github.com/login/device",
    userUrl: "https://api.github.com/user",
    userAccept: "application/vnd.github+json",
    accountField: "login",
  },
  gitlab: {
    origin: GITLAB_ORIGIN,
    label: "GitLab",
    codeUrl: "https://gitlab.com/oauth/authorize_device",
    tokenUrl: "https://gitlab.com/oauth/token",
    scope: "api write_repository",
    verificationUrl: "https://gitlab.com/oauth/device",
    userUrl: "https://gitlab.com/api/v4/user",
    userAccept: "application/json",
    accountField: "username",
  },
};

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628: poll every 5 s unless told otherwise, and 5 s slower after each `slow_down`. */
const DEFAULT_INTERVAL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;

export interface DeviceCode {
  host: DeviceSignInHost;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Clock time when the code stops working. */
  expiresAt: number;
  intervalMs: number;
}

export type DeviceSignInErrorKind = "expired" | "denied" | "cancelled" | "offline" | "http";

export interface DeviceSignInError {
  kind: DeviceSignInErrorKind;
  message: string;
}

export type DeviceSignInResult<T> = Result<T, DeviceSignInError>;

export interface DeviceClock {
  now(): number;
  /** Resolves after `ms`, or rejects once `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemDeviceClock: DeviceClock = {
  now: () => Date.now(),
  wait: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

async function postForm(http: HttpClient, url: string, fields: Record<string, string>): Promise<DeviceSignInResult<HttpResponse>> {
  try {
    return ok(await http({
      method: "POST",
      url,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(fields),
      disableRedirects: true,
    }));
  } catch (error) {
    return err({ kind: "offline", message: errorMessage(error) });
  }
}

function failure(json: Record<string, unknown> | null, status: number): DeviceSignInError {
  return {
    kind: "http",
    message: stringField(json, "error_description") ?? stringField(json, "error") ?? `HTTP ${status}`,
  };
}

/** Asks the host for a user code to show and a device code to poll with. */
export async function requestDeviceCode(
  host: DeviceSignInHost,
  clientId: string,
  http: HttpClient,
  clock: DeviceClock,
): Promise<DeviceSignInResult<DeviceCode>> {
  const config = DEVICE_SIGN_IN_HOSTS[host];
  const response = await postForm(http, config.codeUrl, { client_id: clientId, scope: config.scope });
  if (!isOk(response)) return response;
  const json = parseJsonObject(response.value.bodyText);
  const deviceCode = stringField(json, "device_code");
  const userCode = stringField(json, "user_code");
  const expiresIn = json?.expires_in;
  if (response.value.status !== 200 || !deviceCode || !userCode || typeof expiresIn !== "number") {
    return err(failure(json, response.value.status));
  }
  const interval = json?.interval;
  return ok({
    host,
    deviceCode,
    userCode,
    verificationUrl: config.verificationUrl,
    expiresAt: clock.now() + expiresIn * 1000,
    intervalMs: typeof interval === "number" && interval >= 0 ? interval * 1000 : DEFAULT_INTERVAL_MS,
  });
}

/**
 * Polls until the user approves the code in the browser, then reads who
 * signed in and returns the credential to save. Pending answers keep
 * polling; `slow_down` adds 5 s; expiry, denial and cancellation stop.
 */
export async function completeDeviceSignIn(
  code: DeviceCode,
  clientId: string,
  http: HttpClient,
  clock: DeviceClock,
  signal?: AbortSignal,
): Promise<DeviceSignInResult<HostCredential>> {
  const config = DEVICE_SIGN_IN_HOSTS[code.host];
  let intervalMs = code.intervalMs;
  for (;;) {
    if (signal?.aborted) return err({ kind: "cancelled", message: "Sign-in was cancelled." });
    if (clock.now() >= code.expiresAt) return err({ kind: "expired", message: "The code expired." });
    try {
      await clock.wait(intervalMs, signal);
    } catch {
      return err({ kind: "cancelled", message: "Sign-in was cancelled." });
    }
    const response = await postForm(http, config.tokenUrl, {
      client_id: clientId,
      device_code: code.deviceCode,
      grant_type: DEVICE_CODE_GRANT,
    });
    if (signal?.aborted) return err({ kind: "cancelled", message: "Sign-in was cancelled." });
    // A dropped connection (the app backgrounded while the user approves) keeps polling until the code expires.
    if (!isOk(response)) continue;
    const json = parseJsonObject(response.value.bodyText);
    const token = stringField(json, "access_token");
    if (token) return signedInCredential(code.host, token, json, http, clock);
    switch (stringField(json, "error")) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_MS;
        continue;
      case "expired_token":
        return err({ kind: "expired", message: "The code expired." });
      case "access_denied":
        return err({ kind: "denied", message: "Access was denied." });
      default:
        return err(failure(json, response.value.status));
    }
  }
}

/** The credential for a new sign-in token, named after the account it belongs to. */
async function signedInCredential(
  host: DeviceSignInHost,
  token: string,
  grant: Record<string, unknown> | null,
  http: HttpClient,
  clock: DeviceClock,
): Promise<DeviceSignInResult<HostCredential>> {
  const config = DEVICE_SIGN_IN_HOSTS[host];
  const credential: HostCredential = { origin: config.origin, username: credentialUsername(host), token, kind: host };
  // GitLab sign-in tokens expire (GitHub OAuth App tokens do not); keep what refreshes them.
  const refreshToken = stringField(grant, "refresh_token");
  const expiresIn = grant?.expires_in;
  if (host === "gitlab" && refreshToken && typeof expiresIn === "number" && expiresIn > 0) {
    credential.refreshToken = refreshToken;
    credential.expiresAt = clock.now() + expiresIn * 1000;
  }
  let response: HttpResponse;
  try {
    response = await authorizedHttp(fixedCredential(credential), http, "bearer")({
      method: "GET",
      url: config.userUrl,
      headers: { Accept: config.userAccept },
    });
  } catch (error) {
    return err({ kind: "offline", message: errorMessage(error) });
  }
  const json = parseJsonObject(response.bodyText);
  const account = stringField(json, config.accountField);
  if (response.status !== 200 || !account) return err(failure(json, response.status));
  const id = json?.id;
  return ok({ ...credential, account, ...(typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? { accountId: String(id) } : {}) });
}
