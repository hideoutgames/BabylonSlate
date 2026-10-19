import { CapacitorHttp } from "@capacitor/core";
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
} from "./platform";

export function createNativeHttp(): NativeHttp | null {
  if (isMobilePlatform()) {
    return capacitorNativeHttp;
  }
  if (isElectronHost()) {
    const bridge = getElectronHttpBridge();
    if (!bridge) return null;
    return (request) => bridge.fetch(request);
  }
  return null;
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
  const kept = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() !== "content-type",
  );
  return {
    headers: {
      ...Object.fromEntries(kept),
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

async function capacitorNativeHttp(
  request: NativeHttpRequest,
): Promise<NativeHttpResponse> {
  const response = await CapacitorHttp.request({
    url: request.url,
    method: request.method,
    ...(request.upload
      ? capacitorUploadOptions(request.headers, request.upload)
      : { headers: request.headers, data: request.body }),
    responseType: "text",
  });
  const data = response.data;
  const bodyText =
    typeof data === "string"
      ? data
      : data == null
        ? ""
        : JSON.stringify(data);
  return { status: response.status, bodyText, headers: response.headers };
}
