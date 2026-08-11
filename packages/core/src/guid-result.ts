/** Opaque string identifier for assets and runtime objects. */
export type Guid = string;

export type GuidFactory = () => Guid;

/**
 * Generate a new guid. Prefer `crypto.randomUUID` when available.
 * Pass a factory in tests for deterministic ids.
 */
export function newGuid(factory?: GuidFactory): Guid {
  if (factory) return factory();
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `guid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
