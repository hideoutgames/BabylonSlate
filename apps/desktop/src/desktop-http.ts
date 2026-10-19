import { randomUUID } from "node:crypto";

/** One image sent as the only part of a multipart body; see `NativeHttpImageUpload`. */
export type DesktopHttpImageUpload = {
  field: string;
  fileName: string;
  contentType: string;
  base64: string;
};

export type DesktopHttpRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  upload?: DesktopHttpImageUpload;
};

/** Writes the upload as one `multipart/form-data` part under a fresh boundary. */
export function encodeMultipartImage(upload: DesktopHttpImageUpload) {
  const boundary = `----haptic-${randomUUID()}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${upload.field}"; filename="${upload.fileName}"\r\n` +
    `Content-Type: ${upload.contentType}\r\n\r\n`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(head),
      Buffer.from(upload.base64, "base64"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

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
  const multipart = request.upload ? encodeMultipartImage(request.upload) : null;
  const response = await fetchRequest(request.url, {
    method: request.method ?? "GET",
    // A caller's Content-Type cannot carry the boundary, so the upload sets its own.
    headers: multipart
      ? {
          ...Object.fromEntries(
            Object.entries(request.headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-type"),
          ),
          "Content-Type": multipart.contentType,
        }
      : (request.headers ?? {}),
    body: multipart ? multipart.body : request.body,
    redirect: "error",
    credentials: "omit",
  });
  return {
    status: response.status,
    bodyText: await boundedText(response, maxResponseBytes),
    headers: Object.fromEntries(response.headers.entries()),
  };
}
