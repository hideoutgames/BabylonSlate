/** One request through the host's native HTTP (CapacitorHttp, Electron `net.fetch`); web has none. */
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Return a 3xx as is instead of following it. Every credentialed request sets it. */
  disableRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  bodyText: string;
  headers?: Record<string, string>;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** The response object, or null when the body is empty, invalid JSON, or not an object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The response array, or null when the body is not a JSON array. */
export function parseJsonArray(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringField(json: Record<string, unknown> | null, key: string): string | null {
  const value = json?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}
