import {
  createNativeHttp,
  createAccountSecretStore,
  getHostPlatform,
  MemorySecretStore,
  type NativeHttp,
  type SecretStore,
} from "@babylonslate/vfs";

export interface NativeClerkSession {
  id: string;
  userId: string;
  email: string;
  name?: string;
  imageUrl?: string;
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
};

/** Deliberately excludes server diagnostics, headers, and request bodies. */
export class NativeClerkError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safeCode = Object.hasOwn(messages, code)
      ? code
      : "authentication_failed";
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
  const name = [user.first_name, user.last_name]
    .filter((part) => typeof part === "string" && part)
    .join(" ");
  return {
    id: current.id,
    userId: user.id,
    email,
    ...(name ? { name } : {}),
    ...(typeof user.image_url === "string" &&
    user.image_url.startsWith("https://")
      ? { imageUrl: user.image_url }
      : {}),
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

  private request(
    path: string,
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    // Clerk rotates the client JWT. Serialize transport and persistence together.
    const operation = this.requests.then(async () => {
      const token = await this.storedToken();
      const url = new URL(`/v1/client${path}`, this.origin);
      url.searchParams.set("_is_native", "1");
      url.searchParams.set("__clerk_api_version", "2025-11-10");
      let response;
      try {
        response = await this.http({
          method: body ? "POST" : "GET",
          url: url.href,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Mobile": "1",
            ...(token ? { Authorization: token } : {}),
          },
          ...(body ? { body: new URLSearchParams(body).toString() } : {}),
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
        (response.status === 404 && path.startsWith("/sessions/"))
      ) {
        await this.saveToken(null);
        throw new NativeClerkError("session_unavailable");
      }
      let payload: Record<string, unknown>;
      try {
        payload = record(JSON.parse(response.bodyText));
      } catch {
        throw new NativeClerkError("authentication_failed");
      }
      if (response.status < 200 || response.status >= 300) {
        const error = Array.isArray(payload.errors)
          ? record(payload.errors[0])
          : {};
        throw new NativeClerkError(
          response.status === 429
            ? "too_many_requests"
            : String(error.code ?? "authentication_failed"),
        );
      }
      return record(payload.response);
    });
    this.requests = operation.catch(() => undefined);
    return operation;
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
}

// Android has no secure-store plugin in this repository yet. Keep its token in
// this process only until a Keystore-backed host adapter is supplied.
const androidSessionSecrets = new MemorySecretStore();

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
    host === "android" ? androidSessionSecrets : createAccountSecretStore(),
  );
}
