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
    const limits = { text: 8, binary: 8 };
    await expect(
      fetchDesktopHttp(request, async () => new Response("x".repeat(9), { headers: { "Content-Length": "9" } }), limits),
    ).rejects.toThrow("too large");
    const chunks = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    await expect(fetchDesktopHttp(request, async () => new Response(chunks()), limits)).rejects.toThrow("too large");
    await expect(fetchDesktopHttp({ ...request, responseType: "binary" }, async () => new Response(chunks()), limits)).rejects.toThrow("too large");
    expect((await fetchDesktopHttp(request, async () => new Response("é".repeat(4)), limits)).bodyText).toBe("éééé");
  });

  // Git packs and LFS objects: bytes that are not valid UTF-8 must arrive unchanged in both directions.
  it("sends a byte body as is and answers a binary request with the exact bytes", async () => {
    const sent = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80]);
    const answer = Uint8Array.from([0x00, 0x08, 0xc3, 0x28, 0xff, 0x01]);
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(answer, { status: 200, headers: { "Content-Type": "application/x-git-receive-pack-result" } }),
    );
    const result = await fetchDesktopHttp(
      {
        url: "https://github.com/org/game.git/git-receive-pack",
        method: "POST",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
        body: sent.buffer,
        responseType: "binary",
      },
      fetch,
    );
    expect(new Uint8Array(await new Response(fetch.mock.calls[0]![1].body).arrayBuffer())).toEqual(sent);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(result).toEqual({
      status: 200,
      bodyText: "",
      bodyBytes: answer,
      headers: { "content-type": "application/x-git-receive-pack-result" },
    });
  });
});
