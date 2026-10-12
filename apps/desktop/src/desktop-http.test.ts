import { describe, expect, it, vi } from "vitest";
import { fetchDesktopHttp } from "./desktop-http";

describe("desktop native HTTP", () => {
  it("returns rotating response credentials without sending browser cookies or following redirects", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"response":{}}', {
          status: 200,
          headers: { Authorization: "rotated-client" },
        }),
    );
    const result = await fetchDesktopHttp(
      {
        url: "https://example.clerk.accounts.dev/v1/client?_is_native=1",
        method: "GET",
        headers: { Authorization: "current-client" },
      },
      fetch,
    );
    expect(result).toMatchObject({
      status: 200,
      bodyText: '{"response":{}}',
      headers: { authorization: "rotated-client" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://example.clerk.accounts.dev/v1/client?_is_native=1",
      {
        method: "GET",
        headers: { Authorization: "current-client" },
        body: undefined,
        redirect: "error",
        credentials: "omit",
      },
    );
  });

  it("rejects a response body larger than the cap, declared or streamed", async () => {
    const request = { url: "https://lfs.example.com/locks" };
    await expect(
      fetchDesktopHttp(request, async () => new Response("x".repeat(9), { headers: { "Content-Length": "9" } }), 8),
    ).rejects.toThrow("too large");
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    await expect(fetchDesktopHttp(request, async () => new Response(chunks), 8)).rejects.toThrow("too large");
    expect((await fetchDesktopHttp(request, async () => new Response("é".repeat(4)), 8)).bodyText).toBe("éééé");
  });
});
