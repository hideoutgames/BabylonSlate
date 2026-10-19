/** Image types a profile picture upload may carry. */
export type NativeHttpImageType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/**
 * One image sent as the only part of a `multipart/form-data` body. Each
 * transport encodes it natively, so callers never build the boundary.
 */
export interface NativeHttpImageUpload {
  /** Form field name, such as `file`. */
  field: string;
  fileName: string;
  contentType: NativeHttpImageType;
  /** The image bytes, base64 encoded. */
  base64: string;
}

export interface NativeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** POST only and instead of `body`. The transport sets Content-Type. */
  upload?: NativeHttpImageUpload;
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
