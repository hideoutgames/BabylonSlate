export interface NativeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface NativeHttpResponse {
  status: number;
  bodyText: string;
  /** Available on native transports, including rotated authentication headers. */
  headers?: Record<string, string>;
}

export type NativeHttp = (
  request: NativeHttpRequest,
) => Promise<NativeHttpResponse>;
