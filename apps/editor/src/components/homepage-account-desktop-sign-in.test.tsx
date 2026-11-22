import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NativeHttpRequest, NativeHttpResponse } from "@haptic/vfs";
import { HomepageAccount } from "./homepage-account";

/**
 * The real NativeClerkClient behind the real desktop account row and sign-in
 * dialog; only Clerk's servers (native HTTP) and the OS account store are
 * stand-ins. Clerk rotates the client token on every response and refuses a
 * request that does not carry the latest one.
 */
const server = vi.hoisted(() => ({
  token: 0,
  verified: false,
  requests: [] as NativeHttpRequest[],
  secrets: new Map<string, string>(),
}));

vi.mock("@haptic/vfs", async (original) => {
  const actual = await original<typeof import("@haptic/vfs")>();
  return {
    ...actual,
    getHostPlatform: () => "electron",
    createAuthBrowser: () => null,
    createNativeHttp: () => clerkServer,
    createAccountSecretStore: () => ({
      available: true,
      get: async (key: string) => server.secrets.get(key) ?? null,
      set: async (key: string, value: string) => void server.secrets.set(key, value),
      delete: async (key: string) => void server.secrets.delete(key),
    }),
  };
});

const key = `pk_test_${btoa("example.clerk.accounts.dev$")}`;
const signIn = {
  id: "sia_ada",
  status: "needs_first_factor",
  supported_first_factors: [{ strategy: "email_code", email_address_id: "email_ada" }],
};
const signedInClient = {
  object: "client",
  last_active_session_id: "sess_ada",
  sessions: [
    {
      id: "sess_ada",
      status: "active",
      user: {
        id: "user_ada",
        first_name: "Ada",
        last_name: "Lovelace",
        primary_email_address_id: "email_ada",
        email_addresses: [{ id: "email_ada", email_address: "ada@example.test" }],
      },
    },
  ],
};

function reply(value: unknown): NativeHttpResponse {
  server.token += 1;
  return {
    status: 200,
    bodyText: JSON.stringify({ response: value }),
    headers: { Authorization: `client-${server.token}` },
  };
}

async function clerkServer(request: NativeHttpRequest): Promise<NativeHttpResponse> {
  server.requests.push(request);
  const path = new URL(request.url).pathname;
  if (path === "/v1/client" && request.method === "POST") return reply({ object: "client", sessions: [] });
  if (request.headers.Authorization !== `client-${server.token}`)
    return { status: 401, bodyText: JSON.stringify({ errors: [{ code: "authentication_invalid" }] }) };
  // A client without a session, and without naming the pending sign-in: the
  // worst case for a session check that runs in the middle of the sign-in.
  if (path === "/v1/client") return reply(server.verified ? signedInClient : { object: "client", sessions: [] });
  if (path === "/v1/client/sign_ins") return reply(signIn);
  if (path === "/v1/client/sign_ins/sia_ada/prepare_first_factor") return reply(signIn);
  if (path === "/v1/client/sign_ins/sia_ada/attempt_first_factor") {
    server.verified = true;
    return reply({ id: "sia_ada", status: "complete", created_session_id: "sess_ada" });
  }
  throw new Error(`Unexpected request to ${path}`);
}

const sessionChecks = () =>
  server.requests.filter((request) => request.method === "GET" && new URL(request.url).pathname === "/v1/client")
    .length;

beforeAll(async () => {
  await import("./homepage-account-desktop");
});
beforeEach(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", key);
  server.token = 0;
  server.verified = false;
  server.requests = [];
  server.secrets.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function startEmailSignIn() {
  render(<HomepageAccount />);
  fireEvent.click(await screen.findByRole("button", { name: "Guest, Not Signed In" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sign In" }));
  fireEvent.change(await screen.findByLabelText("Email Address"), { target: { value: "ada@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue With Email" }));
  return screen.findByLabelText("Verification Code");
}

/** Switching to the mail app and back: the window loses and regains focus. */
async function returnToApp() {
  await act(async () => {
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
  });
}

describe("desktop sign-in with the shared account client", () => {
  it("finishes an email-code sign-in after the window regains focus while the code is read", async () => {
    const code = await startEmailSignIn();
    const checksBefore = sessionChecks();

    await returnToApp();

    expect(sessionChecks()).toBe(checksBefore);
    expect(server.secrets.get(`haptic-clerk-client:${key}`)).toBe(`client-${server.token}`);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & Continue" }));
    expect(await screen.findByRole("button", { name: "Ada Lovelace, ada@example.test" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("lets the account row check the session again once the sign-in dialog is closed", async () => {
    await startEmailSignIn();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const checksBefore = sessionChecks();

    await returnToApp();

    await waitFor(() => expect(sessionChecks()).toBeGreaterThan(checksBefore));
  });
});
