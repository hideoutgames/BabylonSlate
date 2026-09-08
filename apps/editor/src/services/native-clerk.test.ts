import { describe, expect, it, vi } from "vitest";
import {
  MemorySecretStore,
  type NativeHttpRequest,
  type NativeHttpResponse,
} from "@babylonslate/vfs";
import { NativeClerkClient } from "./native-clerk";

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
