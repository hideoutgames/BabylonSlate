import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemorySecretStore,
  type NativeHttpRequest,
  type NativeHttpResponse,
} from "@babylonslate/vfs";
import { createNativeClerkClient, NativeClerkClient } from "./native-clerk";

afterEach(() => vi.unstubAllGlobals());

const key = `pk_test_${btoa("example.clerk.accounts.dev$")}`;
const session = {
  id: "sess_one",
  status: "active",
  user: {
    id: "user_one",
    first_name: "Sam",
    last_name: "Slate",
    primary_email_address_id: "email_one",
    email_addresses: [{ id: "email_one", email_address: "sam@example.com" }],
  },
};
const client = {
  object: "client",
  sessions: [session],
  last_active_session_id: "sess_one",
};
const signIn = {
  id: "sia_one",
  status: "needs_first_factor",
  supported_first_factors: [
    { strategy: "email_code", email_address_id: "email_one" },
  ],
};

function response(
  value: unknown,
  token?: string,
  status = 200,
): NativeHttpResponse {
  return {
    status,
    bodyText: JSON.stringify({ response: value }),
    ...(token ? { headers: { Authorization: token } } : {}),
  };
}

function transport(replies: NativeHttpResponse[]) {
  const requests: NativeHttpRequest[] = [];
  const http = async (request: NativeHttpRequest) => {
    requests.push(request);
    const next = replies.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  };
  return { http, requests };
}

describe("NativeClerkClient", () => {
  it("restores Electron accounts through the dedicated encrypted credential bridge", async () => {
    const accountSecrets = new MemorySecretStore();
    await accountSecrets.set(`slate-clerk-client:${key}`, "desktop-client");
    const legacyRead = vi.fn();
    const http = vi.fn<(request: NativeHttpRequest) => Promise<NativeHttpResponse>>(
      async () => response(client, "desktop-rotated"),
    );
    vi.stubGlobal("babylonslate", {
      userData: {
        readSettings: async () => null,
        writeSettings: async () => {},
      },
      secrets: { get: legacyRead },
      accountSecrets,
      http: { fetch: http },
    });
    expect(await createNativeClerkClient(key).restoreSession()).toMatchObject({
      id: "sess_one",
    });
    expect(http.mock.calls[0]?.[0]).toMatchObject({
      headers: { Authorization: "desktop-client" },
    });
    expect(await accountSecrets.get(`slate-clerk-client:${key}`)).toBe(
      "desktop-rotated",
    );
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it("carries rotating client tokens across email verification and a cold client restart", async () => {
    const secrets = new MemorySecretStore();
    const { http, requests } = transport([
      response({ object: "client", sessions: [] }, "client-a"),
      response(signIn, "client-b"),
      response(signIn, "client-c"),
      response(
        { id: "sia_one", status: "complete", created_session_id: "sess_one" },
        "client-d",
      ),
      response(client, "client-e"),
      response(client, "client-f"),
    ]);
    const auth = new NativeClerkClient(key, http, secrets);
    expect(await auth.restoreSession()).toBeNull();
    const challenge = await auth.beginEmail(" sam@example.com ", "sign-in");
    expect(await auth.verifyCode(challenge, "123456")).toEqual({
      id: "sess_one",
      userId: "user_one",
      email: "sam@example.com",
      name: "Sam Slate",
      firstName: "Sam",
      lastName: "Slate",
    });
    expect(
      await new NativeClerkClient(key, http, secrets).restoreSession(),
    ).toMatchObject({ id: "sess_one" });
    expect(requests.map((request) => request.headers.Authorization)).toEqual([
      undefined,
      "client-a",
      "client-b",
      "client-c",
      "client-d",
      "client-e",
    ]);
    expect(
      requests.every(
        (request) =>
          new URL(request.url).searchParams.get("_is_native") === "1",
      ),
    ).toBe(true);
    expect(requests[1]?.body).toBe("identifier=sam%40example.com");
    expect(requests[2]?.body).toBe(
      "strategy=email_code&email_address_id=email_one",
    );
    expect(requests[3]?.body).toBe("strategy=email_code&code=123456");
  });

  it("supports sign-up and resends verification on the existing attempt", async () => {
    const { http, requests } = transport([
      response({ object: "client", sessions: [] }, "client-a"),
      response({ id: "sua_one", status: "missing_requirements" }, "client-b"),
      response({ id: "sua_one" }),
      response({ id: "sua_one" }),
      response({
        id: "sua_one",
        status: "complete",
        created_session_id: "sess_one",
      }),
      response(client),
    ]);
    const auth = new NativeClerkClient(key, http, new MemorySecretStore());
    const challenge = await auth.beginEmail("sam@example.com", "sign-up");
    expect(await auth.resendCode(challenge)).toEqual(challenge);
    expect(await auth.verifyCode(challenge, "123456")).toMatchObject({
      id: "sess_one",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/client",
      "/v1/client/sign_ups",
      "/v1/client/sign_ups/sua_one/prepare_verification",
      "/v1/client/sign_ups/sua_one/prepare_verification",
      "/v1/client/sign_ups/sua_one/attempt_verification",
      "/v1/client",
    ]);
    expect(requests[1]?.body).toBe("email_address=sam%40example.com");
  });

  it("does not unlock the app for pending MFA or a revoked server session", async () => {
    const { http } = transport([
      response({ object: "client", sessions: [] }, "client-a"),
      response(signIn),
      response(signIn),
      response({ id: "sia_one", status: "needs_second_factor" }),
      response({ ...client, sessions: [{ ...session, status: "revoked" }] }),
    ]);
    const auth = new NativeClerkClient(key, http, new MemorySecretStore());
    const challenge = await auth.beginEmail("sam@example.com", "sign-in");
    await expect(auth.verifyCode(challenge, "123456")).rejects.toMatchObject({
      code: "additional_verification_required",
    });
    expect(await auth.restoreSession()).toBeNull();
  });

  it("clears an expired client token and keeps sign-up existing-user recovery available", async () => {
    const { http, requests } = transport([
      response({ object: "client", sessions: [] }, "client-a"),
      {
        status: 422,
        bodyText: JSON.stringify({
          errors: [
            {
              code: "form_identifier_exists",
              long_message: "secret diagnostic client-a",
            },
          ],
        }),
      },
      {
        status: 401,
        bodyText: JSON.stringify({ errors: [{ code: "client_expired" }] }),
      },
      response({ object: "client", sessions: [] }, "client-b"),
      response(signIn),
      response(signIn),
    ]);
    const auth = new NativeClerkClient(key, http, new MemorySecretStore());
    await expect(
      auth.beginEmail("sam@example.com", "sign-up"),
    ).rejects.toMatchObject({
      code: "form_identifier_exists",
      message: "An account already uses this email. Sign in instead.",
    });
    expect(await auth.restoreSession()).toBeNull();
    expect(await auth.beginEmail("sam@example.com", "sign-in")).toMatchObject({
      kind: "sign-in",
    });
    expect(requests[3]?.headers.Authorization).toBeUndefined();
  });

  it("revokes the session before clearing local credentials", async () => {
    const secrets = new MemorySecretStore();
    const { http, requests } = transport([
      response({ object: "client", sessions: [] }, "client-a"),
      response(signIn),
      response(signIn),
      response({ id: "sess_one", status: "removed" }, "client-b"),
    ]);
    const auth = new NativeClerkClient(key, http, secrets);
    await auth.beginEmail("sam@example.com", "sign-in");
    await auth.signOut({
      id: "sess_one",
      userId: "user_one",
      email: "sam@example.com",
    });
    expect(new URL(requests[3]!.url).pathname).toBe(
      "/v1/client/sessions/sess_one/remove",
    );
    // The removal still carries the client credential it revokes.
    expect(requests[3]!.headers.Authorization).toBe("client-a");
    expect(
      await new NativeClerkClient(key, http, secrets).restoreSession(),
    ).toBeNull();
  });

  it("finishes local sign-out when the server has already removed the session", async () => {
    const { http } = transport([
      response({ object: "client", sessions: [] }, "client-a"),
      response(signIn),
      response(signIn),
      {
        status: 404,
        bodyText: JSON.stringify({ errors: [{ code: "resource_not_found" }] }),
      },
    ]);
    const auth = new NativeClerkClient(key, http, new MemorySecretStore());
    await auth.beginEmail("sam@example.com", "sign-in");
    await auth.signOut({
      id: "sess_one",
      userId: "user_one",
      email: "sam@example.com",
    });
    expect(await auth.restoreSession()).toBeNull();
  });

  it("redacts transport failures and never sends credentials to malformed key URLs", async () => {
    const http = vi.fn(async () => {
      throw new Error("secret transport headers: client-secret");
    });
    const auth = new NativeClerkClient(key, http, new MemorySecretStore());
    await expect(
      auth.beginEmail("sam@example.com", "sign-in"),
    ).rejects.toMatchObject({
      code: "network_error",
      message:
        "Could not connect to your account. Check your connection and try again.",
    });
    expect(
      () =>
        new NativeClerkClient(
          `pk_test_${btoa("evil.test/path$")}`,
          http,
          new MemorySecretStore(),
        ),
    ).toThrow(/configuration/i);
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe("NativeClerkClient account management", () => {
  const user = {
    ...session.user,
    username: null,
    image_url: "https://img.clerk.com/default-avatar",
    has_image: false,
    delete_self_enabled: true,
  };
  const clientOf = (overrides: Record<string, unknown> = {}) => ({
    ...client,
    sessions: [{ ...session, user: { ...user, ...overrides } }],
  });
  const current = {
    id: "sess_one",
    userId: "user_one",
    email: "sam@example.com",
    name: "Sam Slate",
    firstName: "Sam",
    lastName: "Slate",
    deleteSelfEnabled: true,
  };
  const failure = (status: number, code: string): NativeHttpResponse => ({
    status,
    bodyText: JSON.stringify({ errors: [{ code, long_message: "secret server detail" }] }),
  });
  async function signedIn(replies: NativeHttpResponse[]) {
    const secrets = new MemorySecretStore();
    await secrets.set(`slate-clerk-client:${key}`, "client-a");
    const { http, requests } = transport(replies);
    return { auth: new NativeClerkClient(key, http, secrets), requests, secrets };
  }
  const path = (request?: NativeHttpRequest) => {
    const url = new URL(request!.url);
    return `${url.pathname}?${[...url.searchParams].filter(([name]) => name !== "__clerk_api_version").map(([name, value]) => `${name}=${value}`).join("&")}`;
  };

  it("reads the picture only when the user uploaded one, plus the name parts and whether deletion is on", async () => {
    const { auth } = await signedIn([
      response(clientOf({ username: "sam", has_image: true, image_url: "https://img.clerk.com/sam.png" })),
      response(clientOf({ delete_self_enabled: false, first_name: null, last_name: null })),
    ]);
    expect(await auth.restoreSession()).toEqual({
      ...current,
      username: "sam",
      imageUrl: "https://img.clerk.com/sam.png",
    });
    // Clerk still reports a generated avatar URL for users without a picture.
    expect(await auth.restoreSession()).toEqual({
      id: "sess_one",
      userId: "user_one",
      email: "sam@example.com",
    });
  });

  it("changes the first and last name as a method-overridden PATCH and returns the stored name", async () => {
    const { auth, requests } = await signedIn([
      response({ object: "user" }, "client-b"),
      response(clientOf({ first_name: "Samantha", last_name: "" }), "client-c"),
    ]);
    const updated = await auth.updateName(current, { firstName: "  Samantha ", lastName: " " });
    expect(updated).toMatchObject({ name: "Samantha", firstName: "Samantha" });
    expect(updated.lastName).toBeUndefined();
    expect(requests.map(path)).toEqual([
      "/v1/me?_is_native=1&_method=PATCH&_clerk_session_id=sess_one",
      "/v1/client?_is_native=1",
    ]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: "first_name=Samantha&last_name=",
      headers: { Authorization: "client-a", "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(requests[1]!.headers.Authorization).toBe("client-b");
  });

  it("uploads a picture as a native multipart image part and removes it with a method-overridden DELETE", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const { auth, requests } = await signedIn([
      response({ object: "image" }),
      response(clientOf({ has_image: true, image_url: "https://img.clerk.com/new.png" })),
      response({ object: "image" }),
      response(clientOf()),
    ]);
    const uploaded = await auth.setProfileImage(current, new File([bytes], "IMG_0042 (1).PNG", { type: "image/png" }));
    expect(uploaded.imageUrl).toBe("https://img.clerk.com/new.png");
    expect(requests[0]).toMatchObject({
      method: "POST",
      upload: { field: "file", fileName: "profile.png", contentType: "image/png", base64: "iVBOR/8A" },
    });
    expect(requests[0]!.body).toBeUndefined();
    expect(requests[0]!.headers["Content-Type"]).toBeUndefined();
    expect(path(requests[0])).toBe("/v1/me/profile_image?_is_native=1&_clerk_session_id=sess_one");
    expect((await auth.removeProfileImage(uploaded)).imageUrl).toBeUndefined();
    expect(path(requests[2])).toBe("/v1/me/profile_image?_is_native=1&_method=DELETE&_clerk_session_id=sess_one");
    expect(requests[2]!.upload).toBeUndefined();
  });

  it("refuses unsupported, oversized, empty and unrecognised pictures before any request", async () => {
    const { auth, requests } = await signedIn([]);
    const refused = (file: Blob) => auth.setProfileImage(current, file);
    await expect(refused(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).rejects.toMatchObject({
      code: "avatar_file_type_invalid",
    });
    await expect(refused(new File(["x"], "photo.heic"))).rejects.toMatchObject({ code: "avatar_file_type_invalid" });
    await expect(refused(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "a.png", { type: "image/png" }))).rejects.toMatchObject({
      code: "avatar_file_size_exceeded",
      message: "That picture is too large. Choose one under 10 MB.",
    });
    await expect(refused(new File([], "a.png", { type: "image/png" }))).rejects.toMatchObject({
      code: "avatar_file_unreadable",
    });
    expect(requests).toEqual([]);
  });

  it("accepts a picture whose provider reported no type when the file name says what it is", async () => {
    const { auth, requests } = await signedIn([response({}), response(clientOf())]);
    await auth.setProfileImage(current, new File([Uint8Array.of(1, 2, 3)], "camera.JPEG"));
    expect(requests[0]!.upload).toMatchObject({ contentType: "image/jpeg", fileName: "profile.jpg", base64: "AQID" });
  });

  it("deletes the user, clears the client token and then restores as signed out without a request", async () => {
    const { auth, requests, secrets } = await signedIn([response({ object: "deleted_object", deleted: true }, "client-rotated")]);
    await auth.deleteAccount(current);
    expect(path(requests[0])).toBe("/v1/me?_is_native=1&_method=DELETE&_clerk_session_id=sess_one");
    expect(requests[0]).toMatchObject({ method: "POST", headers: { Authorization: "client-a" } });
    expect(await secrets.get(`slate-clerk-client:${key}`)).toBeNull();
    expect(await auth.restoreSession()).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("keeps the client token when Clerk refuses the deletion and explains it without server detail", async () => {
    const { auth, secrets } = await signedIn([failure(403, "forbidden"), failure(403, "session_reverification_required")]);
    await expect(auth.deleteAccount(current)).rejects.toMatchObject({
      code: "account_delete_failed",
      message: "Your account could not be deleted. Please try again.",
    });
    await expect(auth.deleteAccount(current)).rejects.toMatchObject({
      code: "session_reverification_required",
      message: "For your security, sign out and sign in again, then try once more.",
    });
    expect(await secrets.get(`slate-clerk-client:${key}`)).toBe("client-a");
  });

  it("names rejected profile edits in plain words and never as a sign-in failure", async () => {
    const { auth } = await signedIn([
      failure(422, "form_param_nil"),
      failure(400, "avatar_file_type_invalid"),
      failure(500, "internal_error"),
      failure(422, "form_param_nil"),
    ]);
    const edit = { firstName: "", lastName: "Slate" };
    await expect(auth.updateName(current, edit)).rejects.toMatchObject({ message: "Enter the missing name and try again." });
    await expect(auth.setProfileImage(current, new File(["x"], "a.png", { type: "image/png" }))).rejects.toMatchObject({
      message: "That picture type is not supported. Choose a JPG, PNG, GIF or WEBP image.",
    });
    await expect(auth.updateName(current, edit)).rejects.toMatchObject({
      message: "Your account could not be updated. Please try again.",
    });
    // The sign-up form has no name field, so a missing parameter there stays a sign-in failure.
    await expect(auth.beginEmail("sam@example.com", "sign-up")).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  it("treats an expired session on a profile call as signed out", async () => {
    const { auth, secrets } = await signedIn([failure(401, "authentication_invalid")]);
    await expect(auth.updateName(current, { firstName: "A", lastName: "B" })).rejects.toMatchObject({
      code: "session_unavailable",
    });
    expect(await secrets.get(`slate-clerk-client:${key}`)).toBeNull();
  });
});
