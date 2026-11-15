import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@haptic/core";
import { completeDeviceSignIn, requestDeviceCode, type DeviceClock } from "./device-flow";
import { FakeGitHost } from "./fake-host";

/** Time moves only when the flow waits; every wait is recorded. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const waits: number[] = [];
  const clock: DeviceClock = {
    now: () => now,
    wait: async (ms, signal) => {
      if (signal?.aborted) throw new Error("cancelled");
      waits.push(ms);
      now += ms;
    },
  };
  return { clock, waits, advance: (ms: number) => { now += ms; } };
}

function form(body: string | Uint8Array | undefined) {
  return Object.fromEntries(new URLSearchParams(typeof body === "string" ? body : ""));
}

describe("device sign-in", () => {
  it("asks GitHub for a code with the repo scope and opens GitHub's own device page", async () => {
    const host = new FakeGitHost();
    host.interval = 5;
    const { clock } = fakeClock();
    const code = await requestDeviceCode("github", "client-1", host.http, clock);
    expect(isOk(code) && code.value).toEqual({
      host: "github",
      deviceCode: "fake-device-code",
      userCode: "WDJB-MJHT",
      // Never the response's verification_uri.
      verificationUrl: "https://github.com/login/device",
      expiresAt: 1_000_000 + 900_000,
      intervalMs: 5_000,
    });
    const [request] = host.requests;
    expect(request?.url).toBe("https://github.com/login/device/code");
    expect(request?.headers.Accept).toBe("application/json");
    expect(form(request?.body)).toEqual({ client_id: "client-1", scope: "repo" });
  });

  it("asks gitlab.com for api and write_repository", async () => {
    const host = new FakeGitHost();
    const code = await requestDeviceCode("gitlab", "client-2", host.http, fakeClock().clock);
    expect(isOk(code) && code.value.verificationUrl).toBe("https://gitlab.com/oauth/device");
    expect(host.requests[0]?.url).toBe("https://gitlab.com/oauth/authorize_device");
    expect(form(host.requests[0]?.body)).toEqual({ client_id: "client-2", scope: "api write_repository" });
  });

  it("keeps polling while pending, slows down by 5 s, then saves the signed-in GitHub account", async () => {
    const host = new FakeGitHost();
    host.interval = 5;
    host.tokenReplies = ["authorization_pending", "slow_down", "authorization_pending"];
    host.account = "ada";
    const { clock, waits } = fakeClock();
    const code = await requestDeviceCode("github", "client-1", host.http, clock);
    if (!isOk(code)) throw new Error("no code");
    const result = await completeDeviceSignIn(code.value, "client-1", host.http, clock);
    expect(isOk(result) && result.value).toEqual({
      origin: "https://github.com",
      username: "x-access-token",
      token: "fake-github-token",
      kind: "github",
      account: "ada",
    });
    expect(waits).toEqual([5_000, 5_000, 10_000, 10_000]);
    const polls = host.requests.filter((request) => request.url === "https://github.com/login/oauth/access_token");
    expect(polls).toHaveLength(4);
    expect(form(polls[0]?.body)).toEqual({
      client_id: "client-1",
      device_code: "fake-device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const user = host.requests.at(-1);
    expect(user?.url).toBe("https://api.github.com/user");
    expect(user?.headers.Authorization).toBe("Bearer fake-github-token");
  });

  it("saves a GitLab sign-in with the oauth2 username, reading errors from 400 replies", async () => {
    const host = new FakeGitHost();
    host.tokenReplies = ["authorization_pending"];
    const { clock } = fakeClock();
    const code = await requestDeviceCode("gitlab", "client-2", host.http, clock);
    if (!isOk(code)) throw new Error("no code");
    const result = await completeDeviceSignIn(code.value, "client-2", host.http, clock);
    expect(isOk(result) && result.value).toMatchObject({ origin: "https://gitlab.com", username: "oauth2", kind: "gitlab", account: "test-user" });
    expect(host.requests.at(-1)?.url).toBe("https://gitlab.com/api/v4/user");
  });

  it("stops on expiry, denial and cancellation without asking for the account", async () => {
    for (const [reply, kind] of [["expired_token", "expired"], ["access_denied", "denied"], ["unsupported_grant_type", "http"]] as const) {
      const host = new FakeGitHost();
      host.tokenReplies = [reply];
      const { clock } = fakeClock();
      const code = await requestDeviceCode("github", "c", host.http, clock);
      if (!isOk(code)) throw new Error("no code");
      const result = await completeDeviceSignIn(code.value, "c", host.http, clock);
      expect(isErr(result) && result.error.kind).toBe(kind);
      expect(host.requests.some((request) => request.url.includes("/user"))).toBe(false);
    }

    const host = new FakeGitHost();
    host.tokenReplies = Array(1_000).fill("authorization_pending");
    host.interval = 60;
    const { clock } = fakeClock();
    const code = await requestDeviceCode("github", "c", host.http, clock);
    if (!isOk(code)) throw new Error("no code");
    const expired = await completeDeviceSignIn(code.value, "c", host.http, clock);
    expect(isErr(expired) && expired.error.kind).toBe("expired");
    // 900 s at a 60 s interval: no poll after the code's lifetime.
    expect(host.requests.filter((request) => request.url.endsWith("/access_token")).length).toBe(15);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await completeDeviceSignIn(code.value, "c", host.http, fakeClock().clock, controller.signal);
    expect(isErr(cancelled) && cancelled.error.kind).toBe("cancelled");
  });

  it("keeps polling through a dropped connection until the user approves", async () => {
    const host = new FakeGitHost();
    host.tokenReplies = [];
    let drops = 2;
    const http = async (request: Parameters<typeof host.http>[0]) => {
      if (request.url.endsWith("/access_token") && drops > 0) {
        drops -= 1;
        throw new Error("The network connection was lost.");
      }
      return host.http(request);
    };
    const { clock, waits } = fakeClock();
    const code = await requestDeviceCode("github", "c", http, clock);
    if (!isOk(code)) throw new Error("no code");
    const result = await completeDeviceSignIn(code.value, "c", http, clock);
    expect(isOk(result) && result.value.token).toBe("fake-github-token");
    expect(waits).toHaveLength(3);
  });

  it("reports an offline network and a refused client", async () => {
    const offline = await requestDeviceCode("github", "c", async () => { throw new Error("offline"); }, fakeClock().clock);
    expect(isErr(offline) && offline.error.kind).toBe("offline");
    const refused = await requestDeviceCode("github", "c", async () => ({ status: 200, bodyText: JSON.stringify({ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled" }) }), fakeClock().clock);
    expect(isErr(refused) && refused.error).toEqual({ kind: "http", message: "Device Flow must be explicitly enabled" });
  });
});
