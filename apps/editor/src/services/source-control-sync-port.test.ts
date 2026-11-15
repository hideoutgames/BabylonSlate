import { describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "@haptic/source-control";
import { commitAuthorFor, monitoredHttp, TransferCancelledError } from "./source-control-sync-port";

describe("monitoredHttp", () => {
  it("counts the bytes each request sends and receives, and refuses requests once cancelled", async () => {
    const controller = new AbortController();
    const bytes = vi.fn();
    const http = vi.fn(async (request: HttpRequest) =>
      request.responseType === "binary" ? { status: 200, bodyText: "", bodyBytes: new Uint8Array(1000) } : { status: 200, bodyText: "héllo" });
    const monitored = monitoredHttp(http, { bytes, signal: () => controller.signal });
    await monitored({ method: "POST", url: "https://git.example.com/a", headers: {}, body: new Uint8Array(300), responseType: "binary" });
    await monitored({ method: "GET", url: "https://git.example.com/b", headers: {} });
    expect(bytes.mock.calls).toEqual([[1300], [6]]);
    controller.abort();
    await expect(monitored({ method: "GET", url: "https://git.example.com/c", headers: {} })).rejects.toBeInstanceOf(TransferCancelledError);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("refuses the answer of a request that was cancelled while it ran", async () => {
    const controller = new AbortController();
    const monitored = monitoredHttp(async () => {
      controller.abort();
      return { status: 200, bodyText: "pack" };
    }, { bytes: () => {}, signal: () => controller.signal });
    await expect(monitored({ method: "GET", url: "https://git.example.com/a", headers: {} })).rejects.toBeInstanceOf(TransferCancelledError);
  });
});

describe("commitAuthorFor", () => {
  it("names the host account, with no guessed email", () => {
    expect(commitAuthorFor({ origin: "https://github.com", username: "x-access-token", token: "t", kind: "github", account: "ada" })).toEqual({ name: "ada", email: "" });
    expect(commitAuthorFor(null)).toEqual({ name: "Haptic", email: "" });
  });
});
