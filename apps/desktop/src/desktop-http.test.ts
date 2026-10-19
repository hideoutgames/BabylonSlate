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

  it("sends an image upload as a multipart form that a standard parser reads back byte for byte", async () => {
    // Includes bytes that are not valid UTF-8 and a CRLF run inside the file.
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response('{"response":{}}', { status: 200 }),
    );
    await fetchDesktopHttp(
      {
        url: "https://example.clerk.accounts.dev/v1/me/profile_image",
        method: "POST",
        headers: { Authorization: "current-client", "content-type": "application/x-www-form-urlencoded" },
        upload: { field: "file", fileName: "avatar.png", contentType: "image/png", base64: Buffer.from(image).toString("base64") },
      },
      fetch,
    );
    const init = fetch.mock.calls[0]![1];
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "content-type")).toEqual(["Content-Type"]);
    expect(headers.Authorization).toBe("current-client");
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=\S+$/);
    const form = await new Response(init.body, { headers: { "content-type": headers["Content-Type"]! } }).formData();
    const file = form.get("file") as File;
    expect([file.name, file.type]).toEqual(["avatar.png", "image/png"]);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(image);
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
