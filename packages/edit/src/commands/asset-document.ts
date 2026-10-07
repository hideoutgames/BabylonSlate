import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

export class SetAssetDocumentCommand implements EditCommand<Record<string, unknown>> {
  readonly type = "asset.setDocument";
  readonly from: Record<string, unknown>;
  readonly to: Record<string, unknown>;
  readonly mergeKey?: string;
  #byteSize?: number;
  /** Retained snapshot cost, measured on first read and memoised. */
  get byteSize(): number {
    return (this.#byteSize ??= snapshotBytes({ from: this.from, to: this.to }));
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
    // Swapping `from` and `to` keeps the measured size.
    inverse.#byteSize = this.#byteSize;
    return inverse;
  }

  /** A gesture keeps only its first `from` and its latest `to`. */
  coalesce(next: EditCommand<Record<string, unknown>>): SetAssetDocumentCommand | undefined {
    if (!(next instanceof SetAssetDocumentCommand) || next.mergeKey !== this.mergeKey) return undefined;
    return new SetAssetDocumentCommand(this.from, next.to, this.mergeKey);
  }
}

export function createSetAssetDocumentCommandFromJson(
  payload: Record<string, unknown>,
): SetAssetDocumentCommand {
  const mergeKey =
    typeof payload.mergeKey === "string" && payload.mergeKey.length > 0
      ? payload.mergeKey
      : undefined;
  return new SetAssetDocumentCommand(
    (payload.from ?? {}) as Record<string, unknown>,
    (payload.to ?? {}) as Record<string, unknown>,
    mergeKey,
  );
}
