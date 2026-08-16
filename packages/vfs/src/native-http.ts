import { CapacitorHttp } from "@capacitor/core";
import type { NativeHttp, NativeHttpRequest, NativeHttpResponse } from "./native-http-port";
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

async function capacitorNativeHttp(
  request: NativeHttpRequest,
): Promise<NativeHttpResponse> {
  const response = await CapacitorHttp.request({
    url: request.url,
    method: request.method,
    headers: request.headers,
    data: request.body,
    responseType: "text",
  });
  const data = response.data;
  const bodyText =
    typeof data === "string"
      ? data
      : data == null
        ? ""
        : JSON.stringify(data);
  return { status: response.status, bodyText };
}
