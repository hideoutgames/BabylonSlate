export type DesktopHttpRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

/** LFS lock pages and account JSON are small; larger bodies never reach the renderer. */
export const MAX_DESKTOP_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

function responseTooLarge(): Error {
  return new Error("Response body is too large");
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw responseTooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw responseTooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function fetchDesktopHttp(
  request: DesktopHttpRequest,
  fetchRequest: (url: string, init: RequestInit) => Promise<Response>,
  maxResponseBytes = MAX_DESKTOP_HTTP_RESPONSE_BYTES,
) {
  const response = await fetchRequest(request.url, {
    method: request.method ?? "GET",
    headers: request.headers ?? {},
    body: request.body,
    redirect: "error",
    credentials: "omit",
  });
  return {
    status: response.status,
    bodyText: await boundedText(response, maxResponseBytes),
    headers: Object.fromEntries(response.headers.entries()),
  };
}
