import {
  createNativeHttp,
  createAccountSecretStore,
  getHostPlatform,
  type NativeHttp,
  type NativeHttpImageType,
  type NativeHttpImageUpload,
  type SecretStore,
} from "@haptic/vfs";

export interface NativeClerkSession {
  id: string;
  userId: string;
  email: string;
  /** First and last name joined, when the user has either. */
  name?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  /** Set only when the user uploaded a picture (Clerk's `has_image`), as on web. */
  imageUrl?: string;
  /** Clerk's `delete_self_enabled`: the dashboard lets users delete their own account. */
  deleteSelfEnabled?: boolean;
}

/**
 * What a session check found. `signed-out` is definitive: Clerk answered 401
 * or 403 with its own JSON, or returned a client without an active session.
 * `offline` is every other outcome (no connection, a timeout, a 5xx or 429, a
 * captive portal's page): the stored credentials stay, and `session` is the
 * last verified user when one is cached. `deferred` means a background check
 * skipped itself because an interactive sign-in owns the client token.
 */
export type NativeClerkRestore =
  | { status: "signed-in"; session: NativeClerkSession }
  | { status: "signed-out" }
  | { status: "offline"; session: NativeClerkSession | null }
  | { status: "deferred" };

/** A pending session reverification: an emailed code that proves who is at the device. */
export interface NativeClerkReverification {
  sessionId: string;
  emailAddressId: string;
  /** The address the code went to. */
  email: string;
}

export interface NativeClerkChallenge {
  id: string;
  kind: "sign-in" | "sign-up";
  email: string;
  emailAddressId?: string;
}

/** A sign-in started with a social provider, waiting for the browser to return. */
export interface NativeClerkOAuth {
  signInId: string;
  /** The provider page to open in the system browser. */
  url: string;
  /** Where Clerk sends the browser back, with the rotating token nonce. */
  redirectUrl: string;
}

const messages: Record<string, string> = {
  configuration_error:
    "Account sign-in configuration is unavailable in this build.",
  secure_storage_unavailable:
    "Secure account storage is unavailable. Please restart the app and try again.",
  network_error:
    "Could not connect to your account. Check your connection and try again.",
  authentication_failed:
    "Account sign-in could not be completed. Please try again.",
  native_api_disabled: "App sign-in is not enabled for this build yet.",
  form_identifier_exists:
    "An account already uses this email. Sign in instead.",
  form_identifier_not_found:
    "No account uses this email yet. Create an account instead.",
  form_code_incorrect: "That code is not correct. Please try again.",
  verification_expired: "That code has expired. Request a new code.",
  verification_failed: "That code could not be verified. Request a new code.",
  too_many_requests: "Please wait a moment before trying again.",
  email_code_unavailable: "Email-code sign-in is not enabled for this account.",
  additional_verification_required:
    "This account requires additional verification that this app build does not support yet.",
  session_unavailable:
    "Your account session has expired. Please sign in again.",
  invalid_email: "Enter a valid email address.",
  account_update_failed: "Your account could not be updated. Please try again.",
  account_delete_failed: "Your account could not be deleted. Please try again.",
  session_reverification_required:
    "For your security, sign out and sign in again, then try once more.",
  reverification_unavailable:
    "This account cannot be verified with an email code in the app. Sign in on the web to delete it.",
  oauth_access_denied: "You did not grant access to your account.",
  oauth_callback_failed:
    "Sign-in with that account could not be completed. Please try again.",
  oauth_sign_up_incomplete:
    "That account is missing details this app cannot collect yet. Use your email instead.",
  name_required: "Enter the missing name and try again.",
  first_name_too_long: "That first name is too long.",
  last_name_too_long: "That last name is too long.",
  avatar_file_size_exceeded: "That picture is too large. Choose one under 10 MB.",
  avatar_file_type_invalid:
    "That picture type is not supported. Choose a JPG, PNG, GIF or WEBP image.",
  avatar_file_unreadable: "That picture could not be read. Choose another file.",
};

/** Callback codes that only say the sign-in continues as a sign-up, or the reverse. */
const OAUTH_CONTINUATIONS = new Set([
  "external_account_not_found",
  "external_account_exists",
]);
const OAUTH_STRATEGY = /^oauth_[a-z0-9_]{1,64}$/;

/** Frontend API codes for rejected names; sign-in forms have no name fields to fix. */
const NAME_ERRORS: Record<string, string> = {
  form_param_nil: "name_required",
  form_param_max_length_exceeded__first_name: "first_name_too_long",
  form_param_max_length_exceeded__last_name: "last_name_too_long",
};

/** Deliberately excludes server diagnostics, headers, and request bodies. */
export class NativeClerkError extends Error {
  readonly code: string;
  /** Unknown codes read as `fallback`, so a failed update never says sign-in failed. */
  constructor(code: string, fallback = "authentication_failed") {
    const safeCode = Object.hasOwn(messages, code) ? code : fallback;
    super(messages[safeCode]);
    this.name = "NativeClerkError";
    this.code = safeCode;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resourceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(value)) {
    throw new NativeClerkError("authentication_failed");
  }
  return value;
}

function frontendOrigin(key: string): string {
  try {
    const match = /^pk_(?:test|live)_([A-Za-z0-9+/_=-]+)$/.exec(key);
    const decoded = match
      ? atob(match[1]!.replace(/-/g, "+").replace(/_/g, "/"))
      : "";
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : "";
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)
    ) {
      throw new Error();
    }
    return `https://${host.toLowerCase()}`;
  } catch {
    throw new NativeClerkError("configuration_error");
  }
}

function activeSession(
  value: unknown,
  expectedId?: string,
): NativeClerkSession | null {
  const client = record(value);
  const sessions = Array.isArray(client.sessions)
    ? client.sessions.map(record)
    : [];
  const active = sessions.filter((session) => session.status === "active");
  const current = expectedId
    ? active.find((session) => session.id === expectedId)
    : (active.find((session) => session.id === client.last_active_session_id) ??
      active[0]);
  if (!current) return null;
  const user = record(current.user);
  if (typeof current.id !== "string" || typeof user.id !== "string")
    return null;
  const emails = Array.isArray(user.email_addresses)
    ? user.email_addresses.map(record)
    : [];
  const email = emails.find(
    (entry) => entry.id === user.primary_email_address_id,
  )?.email_address;
  if (typeof email !== "string") return null;
  const firstName = typeof user.first_name === "string" ? user.first_name : "";
  const lastName = typeof user.last_name === "string" ? user.last_name : "";
  const name = [firstName, lastName].filter(Boolean).join(" ");
  return {
    id: current.id,
    userId: user.id,
    email,
    ...(name ? { name } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(typeof user.username === "string" && user.username
      ? { username: user.username }
      : {}),
    // Without an uploaded picture Clerk still returns a generated avatar URL.
    ...(user.has_image === true &&
    typeof user.image_url === "string" &&
    user.image_url.startsWith("https://")
      ? { imageUrl: user.image_url }
      : {}),
    ...(user.delete_self_enabled === true ? { deleteSelfEnabled: true } : {}),
  };
}

/** Text fields of a cached user. The cache holds `NativeClerkSession` fields only, never a token. */
const CACHED_USER_TEXT = [
  "name",
  "firstName",
  "lastName",
  "username",
  "imageUrl",
] as const;

function cachedSession(json: string | null): NativeClerkSession | null {
  if (!json) return null;
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(json));
  } catch {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.email !== "string"
  )
    return null;
  const session: NativeClerkSession = {
    id: value.id,
    userId: value.userId,
    email: value.email,
  };
  for (const field of CACHED_USER_TEXT) {
    const text = value[field];
    if (typeof text === "string" && text) session[field] = text;
  }
  if (value.deleteSelfEnabled === true) session.deleteSelfEnabled = true;
  return session;
}

/** A 401, 403 or 404 counts as Clerk's answer only when Clerk wrote the body. */
function clerkErrorBody(bodyText: string): boolean {
  try {
    return Array.isArray(record(JSON.parse(bodyText)).errors);
  } catch {
    return false;
  }
}

interface FapiOptions {
  /** Path under `/v1`, such as `/client/sign_ins` or `/me`. */
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, string>;
  upload?: NativeHttpImageUpload;
  /** Picks one session of the client for `/me` calls. */
  sessionId?: string;
  /** The error code that unknown server errors read as. */
  failure?: string;
  /** Server error codes that this request reports under other codes. */
  errors?: Record<string, string>;
  /** Drops the client token on success instead of keeping the rotated one. */
  endsSession?: boolean;
  /**
   * A 403 from Clerk also means the token is no longer accepted. Only the
   * session check sets this: elsewhere 403 carries other refusals, such as
   * `session_reverification_required`.
   */
  signsOutOn403?: boolean;
  /** Extra query parameters, such as the OAuth `rotating_token_nonce`. */
  query?: Record<string, string>;
  /** Returns the whole payload, for endpoints (`/environment`) without a `response` envelope. */
  raw?: boolean;
}

/**
 * How long an interactive sign-in holds off background session checks. Clerk
 * expires sign-in attempts and email codes well within this, so a flow the UI
 * never finished or cancelled cannot disable the checks for good.
 */
export const SIGN_IN_HOLD_MS = 15 * 60 * 1000;

/** Native email-code flow over Clerk's versioned public Frontend API. */
export class NativeClerkClient {
  private readonly origin: string;
  private readonly tokenKey: string;
  /** The last verified user, beside the token, so the mobile apps open offline. */
  private readonly userKey: string;
  private requests: Promise<unknown> = Promise.resolve();
  private readonly http: NativeHttp;
  private readonly secrets: SecretStore;
  /** When the interactive sign-in in progress started or last moved on; null when none. */
  private signInSince: number | null = null;

  constructor(publishableKey: string, http: NativeHttp, secrets: SecretStore) {
    this.origin = frontendOrigin(publishableKey);
    this.tokenKey = `slate-clerk-client:${publishableKey}`;
    this.userKey = `slate-clerk-user:${publishableKey}`;
    this.http = http;
    this.secrets = secrets;
  }

  /**
   * True from `beginEmail` / `beginOAuth` until the sign-in completes, fails
   * for good, is cancelled, or `SIGN_IN_HOLD_MS` passes without progress.
   */
  get signInInProgress(): boolean {
    if (this.signInSince !== null && Date.now() - this.signInSince > SIGN_IN_HOLD_MS)
      this.signInSince = null;
    return this.signInSince !== null;
  }

  /** The UI abandoned the sign-in: the browser closed, the form went back or unmounted. */
  cancelSignIn(): void {
    this.signInSince = null;
  }

  private markSignIn(): void {
    this.signInSince = Date.now();
  }

  /** Runs `operation` in the request queue, after every earlier request and its token write. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.requests.then(operation);
    this.requests = next.catch(() => undefined);
    return next;
  }

  private async storedToken(): Promise<string | null> {
    try {
      return await this.secrets.get(this.tokenKey);
    } catch {
      throw new NativeClerkError("secure_storage_unavailable");
    }
  }

  /** Clearing the token also forgets the cached user. */
  private async saveToken(token: string | null): Promise<void> {
    try {
      if (token) {
        await this.secrets.set(this.tokenKey, token);
      } else {
        await this.secrets.delete(this.tokenKey);
        await this.secrets.delete(this.userKey);
      }
    } catch {
      throw new NativeClerkError("secure_storage_unavailable");
    }
  }

  /** Caches the verified user; a storage failure only costs offline access. */
  private async rememberUser(session: NativeClerkSession): Promise<void> {
    try {
      await this.secrets.set(this.userKey, JSON.stringify(session));
    } catch {
      /* The next online check caches it again. */
    }
  }

  private async forgetUser(): Promise<void> {
    try {
      await this.secrets.delete(this.userKey);
    } catch {
      throw new NativeClerkError("secure_storage_unavailable");
    }
  }

  private async cachedUser(): Promise<NativeClerkSession | null> {
    try {
      return cachedSession(await this.secrets.get(this.userKey));
    } catch {
      return null;
    }
  }

  /** `PATCH` and `DELETE` go out as POST with `_method`, as clerk-js sends them. */
  private fapi(options: FapiOptions): Promise<Record<string, unknown>> {
    // Clerk rotates the client JWT. Serialize transport and persistence together.
    return this.serial(() => this.send(options));
  }

  /** One Frontend API request; only ever called inside the request queue. */
  private async send(options: FapiOptions): Promise<Record<string, unknown>> {
    const { path, body, upload, failure = "authentication_failed" } = options;
    const method = options.method ?? (body || upload ? "POST" : "GET");
    const token = await this.storedToken();
    const url = new URL(`/v1${path}`, this.origin);
    url.searchParams.set("_is_native", "1");
    url.searchParams.set("__clerk_api_version", "2025-11-10");
    if (method === "PATCH" || method === "DELETE")
      url.searchParams.set("_method", method);
    if (options.sessionId)
      url.searchParams.set("_clerk_session_id", options.sessionId);
    for (const [name, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(name, value);
    let response;
    try {
      response = await this.http({
        method: method === "GET" ? "GET" : "POST",
        url: url.href,
        headers: {
          Accept: "application/json",
          // An upload's transport writes its own multipart Content-Type.
          ...(upload
            ? {}
            : { "Content-Type": "application/x-www-form-urlencoded" }),
          "X-Mobile": "1",
          ...(token ? { Authorization: token } : {}),
        },
        ...(body ? { body: new URLSearchParams(body).toString() } : {}),
        ...(upload ? { upload } : {}),
      });
    } catch {
      throw new NativeClerkError("network_error");
    }
    const rotated = Object.entries(response.headers ?? {}).find(
      ([name]) => name.toLowerCase() === "authorization",
    )?.[1];
    if (typeof rotated === "string" && rotated) await this.saveToken(rotated);
    const endsSession =
      response.status === 401 ||
      (response.status === 403 && options.signsOutOn403 === true) ||
      (response.status === 404 && path.startsWith("/client/sessions/"));
    if (endsSession) {
      // A captive portal or proxy can answer 401 or 403 too; only Clerk's own
      // error body ends the session, anything else reads as no connection.
      if (!clerkErrorBody(response.bodyText))
        throw new NativeClerkError("network_error");
      await this.saveToken(null);
      throw new NativeClerkError("session_unavailable");
    }
    const succeeded = response.status >= 200 && response.status < 300;
    let payload: Record<string, unknown>;
    try {
      payload = record(
        response.status === 204 ? {} : JSON.parse(response.bodyText),
      );
    } catch {
      // A success that is not JSON came from a captive portal, not Clerk.
      throw new NativeClerkError(succeeded ? "network_error" : failure, failure);
    }
    if (!succeeded) {
      const error = Array.isArray(payload.errors)
        ? record(payload.errors[0])
        : {};
      const code = String(error.code ?? failure);
      throw new NativeClerkError(
        response.status === 429
          ? "too_many_requests"
          : options.errors && Object.hasOwn(options.errors, code)
            ? options.errors[code]!
            : code,
        failure,
      );
    }
    if (options.endsSession) await this.saveToken(null);
    return record(options.raw ? payload : payload.response);
  }

  private request(
    path: string,
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.fapi({ path: `/client${path}`, body });
  }

  /**
   * Checks the stored client with Clerk; see `NativeClerkRestore` for what
   * each outcome means. Runs in the request queue, so it never interleaves
   * with a sign-in's requests and token writes. A `background` check skips
   * itself while an interactive sign-in is in progress. No check clears the
   * token while a sign-in is in progress or Clerk reports a pending sign-in
   * or sign-up on the client: that token is the sign-in's.
   */
  restore(
    options: { background?: boolean } = {},
  ): Promise<NativeClerkRestore> {
    return this.serial(async (): Promise<NativeClerkRestore> => {
      if (options.background && this.signInInProgress)
        return { status: "deferred" };
      if (!(await this.storedToken())) {
        // A user cached without a token is left over from an interrupted clear.
        await this.saveToken(null);
        return { status: "signed-out" };
      }
      let payload: Record<string, unknown>;
      try {
        payload = await this.send({ path: "/client", raw: true, signsOutOn403: true });
      } catch (error) {
        if (!(error instanceof NativeClerkError)) throw error;
        if (error.code === "session_unavailable") return { status: "signed-out" };
        if (error.code === "secure_storage_unavailable") throw error;
        return { status: "offline", session: await this.cachedUser() };
      }
      const value = payload.response;
      const client = record(value);
      // Clerk answers `response: null` when the token names no client.
      if (value !== null && (client.object !== "client" || !Array.isArray(client.sessions)))
        return { status: "offline", session: await this.cachedUser() };
      const session = value === null ? null : activeSession(client);
      if (session) {
        await this.rememberUser(session);
        return { status: "signed-in", session };
      }
      const pending =
        this.signInInProgress ||
        Object.keys(record(client.sign_in)).length > 0 ||
        Object.keys(record(client.sign_up)).length > 0;
      if (pending) await this.forgetUser();
      else await this.saveToken(null);
      return { status: "signed-out" };
    });
  }

  /** Sign-in attempts need a client; the first request creates one and its token. */
  private async ensureClient(): Promise<void> {
    if (await this.storedToken()) return;
    await this.request("", {});
    if (!(await this.storedToken()))
      throw new NativeClerkError("authentication_failed");
  }

  /** The social strategies (`oauth_github`, …) Clerk enables for signing in. */
  async socialStrategies(): Promise<string[]> {
    const environment = await this.fapi({ path: "/environment", raw: true });
    const social = record(record(environment.user_settings).social);
    return Object.values(social)
      .map(record)
      .filter(
        (entry) =>
          entry.enabled === true &&
          entry.authenticatable === true &&
          typeof entry.strategy === "string" &&
          OAUTH_STRATEGY.test(entry.strategy),
      )
      .map((entry) => entry.strategy as string)
      .sort();
  }

  /** Starts a social sign-in; open `url` in the system browser next. */
  async beginOAuth(
    strategy: string,
    redirectUrl: string,
  ): Promise<NativeClerkOAuth> {
    if (!OAUTH_STRATEGY.test(strategy))
      throw new NativeClerkError("authentication_failed");
    this.markSignIn();
    try {
      await this.ensureClient();
      const attempt = await this.request("/sign_ins", {
        strategy,
        redirect_url: redirectUrl,
      });
      const url = record(attempt.first_factor_verification)
        .external_verification_redirect_url;
      if (typeof url !== "string" || !url.startsWith("https://"))
        throw new NativeClerkError("oauth_callback_failed");
      return { signInId: resourceId(attempt.id), url, redirectUrl };
    } catch (error) {
      this.cancelSignIn();
      throw error;
    }
  }

  /**
   * Finishes a social sign-in from the browser's redirect. A first-time
   * account comes back transferable and becomes a sign-up, as in Clerk's SDKs.
   */
  async completeOAuth(
    oauth: NativeClerkOAuth,
    callbackUrl: string,
  ): Promise<NativeClerkSession> {
    // The browser came back, so this sign-in ends here whatever the outcome.
    try {
      return await this.finishOAuth(oauth, callbackUrl);
    } finally {
      this.cancelSignIn();
    }
  }

  private async finishOAuth(
    oauth: NativeClerkOAuth,
    callbackUrl: string,
  ): Promise<NativeClerkSession> {
    let callback: URL;
    let expected: URL;
    try {
      callback = new URL(callbackUrl);
      expected = new URL(oauth.redirectUrl);
    } catch {
      throw new NativeClerkError("oauth_callback_failed");
    }
    if (
      callback.protocol !== expected.protocol ||
      callback.host !== expected.host
    )
      throw new NativeClerkError("oauth_callback_failed");
    const params = callback.searchParams;
    const errorCode = params.get("__clerk_error_code") ?? "oauth_callback_failed";
    if (
      params.get("__clerk_status") === "failed" &&
      !OAUTH_CONTINUATIONS.has(errorCode)
    )
      throw new NativeClerkError(
        errorCode === "oauth_access_denied" ? errorCode : "oauth_callback_failed",
      );
    const nonce = params.get("rotating_token_nonce");
    const attempt = await this.fapi({
      path: `/client/sign_ins/${resourceId(oauth.signInId)}`,
      ...(nonce ? { query: { rotating_token_nonce: nonce } } : {}),
    });
    let createdSessionId: unknown;
    if (attempt.status === "complete") {
      createdSessionId = attempt.created_session_id;
    } else if (
      record(attempt.first_factor_verification).status === "transferable"
    ) {
      const signUp = await this.request("/sign_ups", { transfer: "true" });
      if (signUp.status !== "complete")
        throw new NativeClerkError(
          signUp.status === "missing_requirements"
            ? "oauth_sign_up_incomplete"
            : "additional_verification_required",
        );
      createdSessionId = signUp.created_session_id;
    } else {
      throw new NativeClerkError(
        attempt.status === "needs_second_factor"
          ? "additional_verification_required"
          : "oauth_callback_failed",
      );
    }
    const session = activeSession(
      await this.request(""),
      resourceId(createdSessionId),
    );
    if (!session) throw new NativeClerkError("session_unavailable");
    await this.rememberUser(session);
    return session;
  }

  async beginEmail(
    email: string,
    kind: NativeClerkChallenge["kind"],
  ): Promise<NativeClerkChallenge> {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
      throw new NativeClerkError("invalid_email");
    this.markSignIn();
    try {
      await this.ensureClient();
      const attempt = await this.request(
        kind === "sign-in" ? "/sign_ins" : "/sign_ups",
        kind === "sign-in" ? { identifier: address } : { email_address: address },
      );
      const challenge: NativeClerkChallenge = {
        id: resourceId(attempt.id),
        kind,
        email: address,
      };
      if (kind === "sign-in") {
        const factors = Array.isArray(attempt.supported_first_factors)
          ? attempt.supported_first_factors.map(record)
          : [];
        const emailFactor = factors.find(
          (factor) => factor.strategy === "email_code",
        );
        if (!emailFactor) throw new NativeClerkError("email_code_unavailable");
        challenge.emailAddressId = resourceId(emailFactor.email_address_id);
      }
      return await this.resendCode(challenge);
    } catch (error) {
      // No code was sent, so the form stays on the email step.
      this.cancelSignIn();
      throw error;
    }
  }

  /** Emails the code again; the sign-in stays in progress while the person waits for it. */
  async resendCode(
    challenge: NativeClerkChallenge,
  ): Promise<NativeClerkChallenge> {
    this.markSignIn();
    const id = resourceId(challenge.id);
    if (challenge.kind === "sign-in") {
      await this.request(`/sign_ins/${id}/prepare_first_factor`, {
        strategy: "email_code",
        email_address_id: resourceId(challenge.emailAddressId),
      });
    } else {
      await this.request(`/sign_ups/${id}/prepare_verification`, {
        strategy: "email_code",
      });
    }
    return challenge;
  }

  /**
   * Checks the emailed code. A wrong or expired code keeps the sign-in in
   * progress (the form stays on the code step for another try or a resend);
   * success and a lost client end it.
   */
  async verifyCode(
    challenge: NativeClerkChallenge,
    code: string,
  ): Promise<NativeClerkSession> {
    try {
      const id = resourceId(challenge.id);
      const attempt = await this.request(
        challenge.kind === "sign-in"
          ? `/sign_ins/${id}/attempt_first_factor`
          : `/sign_ups/${id}/attempt_verification`,
        { strategy: "email_code", code: code.trim() },
      );
      if (attempt.status !== "complete")
        throw new NativeClerkError("additional_verification_required");
      const createdId = resourceId(attempt.created_session_id);
      const session = activeSession(await this.request(""), createdId);
      if (!session) throw new NativeClerkError("session_unavailable");
      this.cancelSignIn();
      await this.rememberUser(session);
      return session;
    } catch (error) {
      if (
        error instanceof NativeClerkError &&
        error.code === "session_unavailable"
      )
        this.cancelSignIn();
      throw error;
    }
  }

  /**
   * Revokes the session when Clerk can be reached, and always forgets the
   * local token and cached user, so an offline device can still sign out.
   * Only a secure storage failure rejects.
   */
  signOut(session: NativeClerkSession): Promise<void> {
    this.cancelSignIn();
    return this.serial(async () => {
      try {
        await this.send({
          path: `/client/sessions/${resourceId(session.id)}/remove`,
          body: {},
        });
      } catch {
        /* Unreachable or already removed: the local sign-out still happens. */
      } finally {
        await this.saveToken(null);
      }
    });
  }

  /** The signed-in user as the server now has it. */
  private async refresh(
    session: NativeClerkSession,
    failure: string,
  ): Promise<NativeClerkSession> {
    const id = resourceId(session.id);
    const next = activeSession(
      await this.fapi({ path: "/client", failure }),
      id,
    );
    if (!next) throw new NativeClerkError("session_unavailable");
    await this.rememberUser(next);
    return next;
  }

  /** Changes the name the web account screen edits: Clerk's first and last name. */
  async updateName(
    session: NativeClerkSession,
    name: { firstName: string; lastName: string },
  ): Promise<NativeClerkSession> {
    await this.fapi({
      path: "/me",
      method: "PATCH",
      sessionId: resourceId(session.id),
      body: { first_name: name.firstName.trim(), last_name: name.lastName.trim() },
      failure: "account_update_failed",
      errors: NAME_ERRORS,
    });
    return this.refresh(session, "account_update_failed");
  }

  /** Uploads a new profile picture; Clerk accepts JPG, PNG, GIF and WEBP up to 10 MB. */
  async setProfileImage(
    session: NativeClerkSession,
    file: Blob,
  ): Promise<NativeClerkSession> {
    const upload = await profileImageUpload(file);
    await this.fapi({
      path: "/me/profile_image",
      method: "POST",
      sessionId: resourceId(session.id),
      upload,
      failure: "account_update_failed",
    });
    return this.refresh(session, "account_update_failed");
  }

  async removeProfileImage(
    session: NativeClerkSession,
  ): Promise<NativeClerkSession> {
    await this.fapi({
      path: "/me/profile_image",
      method: "DELETE",
      sessionId: resourceId(session.id),
      body: {},
      failure: "account_update_failed",
    });
    return this.refresh(session, "account_update_failed");
  }

  /**
   * Starts Clerk's session reverification (`POST /client/sessions/{id}/verify`
   * at the first-factor level, as clerk-js does) and emails a code. Accounts
   * that signed up with an OAuth provider verify the same way: the native
   * app has no OAuth, and Clerk offers the email-code factor for any user
   * with a verified address.
   */
  async beginReverification(
    session: NativeClerkSession,
  ): Promise<NativeClerkReverification> {
    const sessionId = resourceId(session.id);
    const verification = await this.fapi({
      path: `/client/sessions/${sessionId}/verify`,
      body: { level: "first_factor" },
      failure: "account_delete_failed",
    });
    const factor = (
      Array.isArray(verification.supported_first_factors)
        ? verification.supported_first_factors.map(record)
        : []
    ).find((candidate) => candidate.strategy === "email_code");
    if (!factor) throw new NativeClerkError("reverification_unavailable");
    const reverification = {
      sessionId,
      emailAddressId: resourceId(factor.email_address_id),
      email:
        typeof factor.safe_identifier === "string" && factor.safe_identifier
          ? factor.safe_identifier
          : session.email,
    };
    return this.resendReverificationCode(reverification);
  }

  /** Emails a code for the reverification, again when the first one did not arrive. */
  async resendReverificationCode(
    reverification: NativeClerkReverification,
  ): Promise<NativeClerkReverification> {
    await this.fapi({
      path: `/client/sessions/${resourceId(reverification.sessionId)}/verify/prepare_first_factor`,
      body: {
        strategy: "email_code",
        email_address_id: resourceId(reverification.emailAddressId),
      },
      failure: "account_delete_failed",
    });
    return reverification;
  }

  /** Throws unless Clerk accepts the emailed code and marks the session verified. */
  async completeReverification(
    reverification: NativeClerkReverification,
    code: string,
  ): Promise<void> {
    const attempt = await this.fapi({
      path: `/client/sessions/${resourceId(reverification.sessionId)}/verify/attempt_first_factor`,
      body: { strategy: "email_code", code: code.trim() },
      failure: "account_delete_failed",
    });
    if (attempt.status !== "complete")
      throw new NativeClerkError("additional_verification_required");
  }

  /**
   * Deletes the Clerk user, then forgets the client token. Only works when the
   * Clerk dashboard lets users delete their own accounts. Callers reverify the
   * session first; Clerk also refuses with `session_reverification_required`
   * when its own window has lapsed.
   */
  async deleteAccount(session: NativeClerkSession): Promise<void> {
    await this.fapi({
      path: "/me",
      method: "DELETE",
      sessionId: resourceId(session.id),
      body: {},
      failure: "account_delete_failed",
      endsSession: true,
    });
  }
}

const PROFILE_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
const PROFILE_IMAGE_TYPES: Record<
  NativeHttpImageType,
  { extension: string; names: RegExp }
> = {
  "image/png": { extension: "png", names: /\.png$/i },
  "image/jpeg": { extension: "jpg", names: /\.jpe?g$/i },
  "image/gif": { extension: "gif", names: /\.gif$/i },
  "image/webp": { extension: "webp", names: /\.webp$/i },
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** Some Android file providers report no type, so fall back to the file name. */
function profileImageType(file: Blob): NativeHttpImageType | null {
  const types = Object.keys(PROFILE_IMAGE_TYPES) as NativeHttpImageType[];
  if (file.type) return types.find((type) => type === file.type) ?? null;
  const name = (file as { name?: unknown }).name;
  return (
    types.find(
      (type) =>
        typeof name === "string" && PROFILE_IMAGE_TYPES[type].names.test(name),
    ) ?? null
  );
}

async function profileImageUpload(file: Blob): Promise<NativeHttpImageUpload> {
  const contentType = profileImageType(file);
  if (!contentType) throw new NativeClerkError("avatar_file_type_invalid");
  if (file.size > PROFILE_IMAGE_LIMIT_BYTES)
    throw new NativeClerkError("avatar_file_size_exceeded");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new NativeClerkError("avatar_file_unreadable");
  }
  if (bytes.length === 0) throw new NativeClerkError("avatar_file_unreadable");
  return {
    field: "file",
    // The picked file's own name never leaves the device.
    fileName: `profile.${PROFILE_IMAGE_TYPES[contentType].extension}`,
    contentType,
    base64: base64(bytes),
  };
}

const clients = new Map<string, NativeClerkClient>();

/**
 * The one client for this publishable key. Every account owner (the desktop
 * account row, its sign-in dialog, the mobile gate) shares it, so all their
 * requests and token writes go through one queue and a background session
 * check sees an interactive sign-in in progress.
 */
export function createNativeClerkClient(
  publishableKey: string,
): NativeClerkClient {
  const existing = clients.get(publishableKey);
  if (existing) return existing;
  const host = getHostPlatform();
  const http = createNativeHttp();
  if ((host !== "ios" && host !== "android" && host !== "electron") || !http)
    throw new NativeClerkError("configuration_error");
  const client = new NativeClerkClient(
    publishableKey,
    http,
    createAccountSecretStore(),
  );
  clients.set(publishableKey, client);
  return client;
}
