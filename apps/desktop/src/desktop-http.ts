import { randomUUID } from "node:crypto";
import { MAX_IPC_BYTES } from "./packaged-security";

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
  /** Text, or bytes (Git packs, LFS objects) as an exact `ArrayBuffer`. */
  body?: string | ArrayBuffer;
  upload?: DesktopHttpImageUpload;
  /** `binary` answers `bodyBytes` instead of `bodyText`. */
  responseType?: "text" | "binary";
};

/** Writes the upload as one `multipart/form-data` part under a fresh boundary. */
function encodeMultipartImage(upload: DesktopHttpImageUpload) {
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

/** LFS lock pages and account JSON are small; larger text never reaches the renderer. */
const MAX_DESKTOP_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

function responseTooLarge(): Error {
  return new Error("Response body is too large");
}

/** The body's chunks, refused past `limit` bytes, declared or streamed. */
async function boundedChunks(response: Response, limit: number, chunk: (value: Uint8Array) => void): Promise<void> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw responseTooLarge();
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw responseTooLarge();
    }
    chunk(value);
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  await boundedChunks(response, limit, (value) => {
    text += decoder.decode(value, { stream: true });
  });
  return text + decoder.decode();
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  await boundedChunks(response, limit, (value) => {
    chunks.push(value);
    length += value.byteLength;
  });
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
}

/**
 * `limits.text` bounds a text answer; `limits.binary` a `binary` one (Git packs
 * and LFS objects), which IPC then carries whole.
 */
export async function fetchDesktopHttp(
  request: DesktopHttpRequest,
  fetchRequest: (url: string, init: RequestInit) => Promise<Response>,
  limits: { text: number; binary: number } = { text: MAX_DESKTOP_HTTP_RESPONSE_BYTES, binary: MAX_IPC_BYTES },
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
  const headers = Object.fromEntries(response.headers.entries());
  if (request.responseType === "binary") {
    return { status: response.status, bodyText: "", bodyBytes: await boundedBytes(response, limits.binary), headers };
  }
  return { status: response.status, bodyText: await boundedText(response, limits.text), headers };
}
