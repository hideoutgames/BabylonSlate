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
});
