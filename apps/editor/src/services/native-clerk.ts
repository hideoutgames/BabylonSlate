import {
  createNativeHttp,
  createAccountSecretStore,
  getHostPlatform,
  type NativeHttp,
  type NativeHttpImageType,
  type NativeHttpImageUpload,
  type SecretStore,
} from "@babylonslate/vfs";

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
  name_required: "Enter the missing name and try again.",
  first_name_too_long: "That first name is too long.",
  last_name_too_long: "That last name is too long.",
  avatar_file_size_exceeded: "That picture is too large. Choose one under 10 MB.",
  avatar_file_type_invalid:
    "That picture type is not supported. Choose a JPG, PNG, GIF or WEBP image.",
  avatar_file_unreadable: "That picture could not be read. Choose another file.",
};

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

/** Native email-code flow over Clerk's versioned public Frontend API. */
export class NativeClerkClient {
  private readonly origin: string;
  private readonly tokenKey: string;
  private requests: Promise<unknown> = Promise.resolve();
  private readonly http: NativeHttp;
  private readonly secrets: SecretStore;

  constructor(publishableKey: string, http: NativeHttp, secrets: SecretStore) {
    this.origin = frontendOrigin(publishableKey);
    this.tokenKey = `slate-clerk-client:${publishableKey}`;
    this.http = http;
    this.secrets = secrets;
  }

  private async storedToken(): Promise<string | null> {
    try {
      return await this.secrets.get(this.tokenKey);
    } catch {
      throw new NativeClerkError("secure_storage_unavailable");
    }
  }

  private async saveToken(token: string | null): Promise<void> {
    try {
      if (token) await this.secrets.set(this.tokenKey, token);
      else await this.secrets.delete(this.tokenKey);
    } catch {
      throw new NativeClerkError("secure_storage_unavailable");
    }
  }

  /** `PATCH` and `DELETE` go out as POST with `_method`, as clerk-js sends them. */
  private fapi(options: {
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
  }): Promise<Record<string, unknown>> {
    const { path, body, upload, failure = "authentication_failed" } = options;
    const method = options.method ?? (body || upload ? "POST" : "GET");
    // Clerk rotates the client JWT. Serialize transport and persistence together.
    const operation = this.requests.then(async () => {
      const token = await this.storedToken();
      const url = new URL(`/v1${path}`, this.origin);
      url.searchParams.set("_is_native", "1");
      url.searchParams.set("__clerk_api_version", "2025-11-10");
      if (method === "PATCH" || method === "DELETE")
        url.searchParams.set("_method", method);
      if (options.sessionId)
        url.searchParams.set("_clerk_session_id", options.sessionId);
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
      if (
        response.status === 401 ||
        (response.status === 404 && path.startsWith("/client/sessions/"))
      ) {
        await this.saveToken(null);
        throw new NativeClerkError("session_unavailable");
      }
      let payload: Record<string, unknown>;
      try {
        payload = record(
          response.status === 204 ? {} : JSON.parse(response.bodyText),
        );
      } catch {
        throw new NativeClerkError(failure, failure);
      }
      if (response.status < 200 || response.status >= 300) {
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
      return record(payload.response);
    });
    this.requests = operation.catch(() => undefined);
    return operation;
  }

  private request(
    path: string,
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.fapi({ path: `/client${path}`, body });
  }

  async restoreSession(): Promise<NativeClerkSession | null> {
    if (!(await this.storedToken())) return null;
    try {
      const session = activeSession(await this.request(""));
      if (!session) await this.saveToken(null);
      return session;
    } catch (error) {
      if (
        error instanceof NativeClerkError &&
        error.code === "session_unavailable"
      )
        return null;
      throw error;
    }
  }

  async beginEmail(
    email: string,
    kind: NativeClerkChallenge["kind"],
  ): Promise<NativeClerkChallenge> {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
      throw new NativeClerkError("invalid_email");
    if (!(await this.storedToken())) {
      await this.request("", {});
      if (!(await this.storedToken()))
        throw new NativeClerkError("authentication_failed");
    }
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
    return this.resendCode(challenge);
  }

  async resendCode(
    challenge: NativeClerkChallenge,
  ): Promise<NativeClerkChallenge> {
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

  async verifyCode(
    challenge: NativeClerkChallenge,
    code: string,
  ): Promise<NativeClerkSession> {
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
    return session;
  }

  async signOut(session: NativeClerkSession): Promise<void> {
    try {
      await this.request(`/sessions/${resourceId(session.id)}/remove`, {});
    } catch (error) {
      if (
        !(error instanceof NativeClerkError) ||
        error.code !== "session_unavailable"
      )
        throw error;
    }
    await this.saveToken(null);
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

export function createNativeClerkClient(
  publishableKey: string,
): NativeClerkClient {
  const host = getHostPlatform();
  const http = createNativeHttp();
  if ((host !== "ios" && host !== "android" && host !== "electron") || !http)
    throw new NativeClerkError("configuration_error");
  return new NativeClerkClient(
    publishableKey,
    http,
    createAccountSecretStore(),
  );
}
