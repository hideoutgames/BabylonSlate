import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { decodeBase64, encodeBase64 } from "./capacitor-scoped-storage";
import type {
  NativeHttp,
  NativeHttpImageUpload,
  NativeHttpRequest,
  NativeHttpResponse,
} from "./native-http-port";
import {
  getElectronHttpBridge,
  isElectronHost,
  isMobilePlatform,
  type ElectronHttpBridge,
} from "./platform";

export function createNativeHttp(): NativeHttp | null {
  if (isMobilePlatform()) {
    return capacitorNativeHttp;
  }
  if (isElectronHost()) {
    const bridge = getElectronHttpBridge();
    if (!bridge) return null;
    return (request) => bridge.fetch(electronRequest(request));
  }
  return null;
}

/** IPC takes a byte body as an exact `ArrayBuffer`, which the main process validates and bounds. */
function electronRequest(request: NativeHttpRequest): Parameters<ElectronHttpBridge["fetch"]>[0] {
  const { body, ...rest } = request;
  if (!(body instanceof Uint8Array)) return { ...rest, ...(body === undefined ? {} : { body }) };
  return { ...rest, body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
}

function withoutContentType(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"));
}

function contentType(headers: Record<string, string>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
}

/**
 * Capacitor's `formData` data type: the native layers write the multipart body
 * and add the boundary to Content-Type, which must still be present (and not
 * JSON or URL-encoded) or they drop the body.
 */
function capacitorUploadOptions(
  headers: Record<string, string>,
  upload: NativeHttpImageUpload,
) {
  return {
    headers: {
      ...withoutContentType(headers),
      "Content-Type": "multipart/form-data",
    },
    data: [
      {
        type: "base64File",
        key: upload.field,
        value: upload.base64,
        fileName: upload.fileName,
        contentType: upload.contentType,
      },
    ],
    dataType: "formData" as const,
  };
}

/**
 * Capacitor's `file` data type: base64 the native layers decode into the body.
 * Both drop a body without Content-Type, and Android reads a JSON type as a
 * JSON body before it looks at the data type.
 */
function capacitorBytesOptions(headers: Record<string, string>, body: Uint8Array) {
  const type = contentType(headers) ?? "application/octet-stream";
  if (/json/i.test(type)) throw new Error("A byte body cannot be sent as JSON through native HTTP.");
  return {
    headers: { ...withoutContentType(headers), "Content-Type": type },
    data: encodeBase64(body),
    dataType: "file" as const,
  };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * An `arraybuffer` answer: base64, except that both platforms parse a JSON
 * content type whatever was asked, and Android sends an error status's body
 * (4xx and 5xx) as plain text. Android wraps its base64 in lines, which
 * `atob` ignores.
 */
function capacitorBytes(status: number, data: unknown): Uint8Array {
  if (data == null || data === "") return new Uint8Array();
  if (typeof data !== "string") return utf8(JSON.stringify(data));
  if (status >= 400 && Capacitor.getPlatform() === "android") return utf8(data);
  return decodeBase64(data);
}

async function capacitorNativeHttp(
  request: NativeHttpRequest,
): Promise<NativeHttpResponse> {
  const binary = request.responseType === "binary";
  const response = await CapacitorHttp.request({
    url: request.url,
    method: request.method,
    ...(request.upload
      ? capacitorUploadOptions(request.headers, request.upload)
      : request.body instanceof Uint8Array
        ? capacitorBytesOptions(request.headers, request.body)
        : { headers: request.headers, data: request.body }),
    ...(request.disableRedirects ? { disableRedirects: true } : {}),
    responseType: binary ? "arraybuffer" : "text",
  });
  const data: unknown = response.data;
  if (binary) {
    return { status: response.status, bodyText: "", bodyBytes: capacitorBytes(response.status, data), headers: response.headers };
  }
  const bodyText =
    typeof data === "string"
      ? data
      : data == null
        ? ""
        : JSON.stringify(data);
  return { status: response.status, bodyText, headers: response.headers };
}
