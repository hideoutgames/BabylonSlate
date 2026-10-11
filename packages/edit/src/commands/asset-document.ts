import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

export class SetAssetDocumentCommand implements EditCommand<Record<string, unknown>> {
  readonly type = "asset.setDocument";
  readonly from: Record<string, unknown>;
  readonly to: Record<string, unknown>;
  readonly mergeKey?: string;
  #fromBytes?: number;
  #toBytes?: number;
  /**
   * Retained snapshot cost. Each side is measured on first read and memoised,
   * and inverting or coalescing carries the measured sides, so each sample of
   * a merged gesture measures only its new `to`.
   */
  get byteSize(): number {
    this.#fromBytes ??= snapshotBytes(this.from);
    this.#toBytes ??= snapshotBytes(this.to);
    return this.#fromBytes + this.#toBytes;
  }

  constructor(
    from: Record<string, unknown>,
    to: Record<string, unknown>,
    mergeKey?: string,
  ) {
    this.from = from;
    this.to = to;
    this.mergeKey = mergeKey;
  }

  apply(doc: Record<string, unknown>): Record<string, unknown> {
    void doc;
    return structuredClone(this.to);
  }

  invert(): SetAssetDocumentCommand {
    const inverse = new SetAssetDocumentCommand(this.to, this.from);
    inverse.#fromBytes = this.#toBytes;
    inverse.#toBytes = this.#fromBytes;
    return inverse;
  }

  /** A gesture keeps only its first `from` and its latest `to`. */
  coalesce(next: EditCommand<Record<string, unknown>>): SetAssetDocumentCommand | undefined {
    if (!(next instanceof SetAssetDocumentCommand) || next.mergeKey !== this.mergeKey) return undefined;
    const merged = new SetAssetDocumentCommand(this.from, next.to, this.mergeKey);
    merged.#fromBytes = this.#fromBytes;
    merged.#toBytes = next.#toBytes;
    return merged;
  }
}

function documentSnapshot(payload: Record<string, unknown>, side: "from" | "to"): Record<string, unknown> {
  const value = payload[side];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`asset.setDocument has no "${side}" document.`);
  }
  return value as Record<string, unknown>;
}

/** Revives a journaled edit; a record without both documents throws, so replay skips it. */
export function createSetAssetDocumentCommandFromJson(
  payload: Record<string, unknown>,
): SetAssetDocumentCommand {
  const mergeKey =
    typeof payload.mergeKey === "string" && payload.mergeKey.length > 0
      ? payload.mergeKey
      : undefined;
  return new SetAssetDocumentCommand(
    documentSnapshot(payload, "from"),
    documentSnapshot(payload, "to"),
    mergeKey,
  );
}
