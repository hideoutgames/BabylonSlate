export interface NativeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface NativeHttpResponse {
  status: number;
  bodyText: string;
}

export type NativeHttp = (
  request: NativeHttpRequest,
) => Promise<NativeHttpResponse>;
