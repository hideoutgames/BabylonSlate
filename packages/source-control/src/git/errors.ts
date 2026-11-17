import { CredentialOriginError, NoCredentialError } from "../credentials";
import { SyncError } from "../sync-port";

/** A request that never got a response: no credential for its origin, or the host could not be reached. */
export function requestError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  if (error instanceof NoCredentialError) return new SyncError("auth", error.message, { code: "no-credential", cause: error });
  if (error instanceof CredentialOriginError) return new SyncError("auth", error.message, { cause: error });
  return new SyncError("network", error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * A response the operation cannot use. `credentialed`: the request carried
 * the saved sign-in (`authorizedHttp`), so a 401 means the host refused it,
 * as renewal could not answer it either.
 */
export function statusError(status: number, what: string, kind: "lfs" | "network" = "lfs", credentialed = false): SyncError {
  if (status === 401 && credentialed) {
    return new SyncError("auth", `${what} refused the saved sign-in (HTTP 401).`, { status, code: "credential-refused" });
  }
  if (status === 401 || status === 403) return new SyncError("auth", `${what}: access refused (HTTP ${status}).`, { status });
  if (status === 404) return new SyncError("not-found", `${what}: not found (HTTP 404).`, { status });
  return new SyncError(kind, `${what} failed (HTTP ${status}).`, { status });
}

/**
 * An isomorphic-git failure as the UI phrases it. Anything else (a storage
 * failure, a bug) passes through unchanged.
 */
export function toSyncError(error: unknown): unknown {
  if (error instanceof SyncError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "HttpError": {
      const status = Number((error as { data?: { statusCode?: unknown } }).data?.statusCode);
      // Git requests always carry the saved sign-in.
      return Object.assign(statusError(status, "The Git server", "network", true), { cause: error });
    }
    case "NotFoundError":
      return new SyncError("not-found", message, { cause: error });
    case "PushRejectedError":
    case "GitPushError":
      return new SyncError("conflict", "The remote branch has commits this copy lacks. Pull first.", { code: "push-rejected", cause: error });
    case "SmartHttpError":
    case "UnknownTransportError":
    case "RemoteCapabilityError":
      return new SyncError("network", message, { cause: error });
    default:
      return error;
  }
}
