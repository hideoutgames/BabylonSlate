import type { EditCommand } from "../command";

export class SetAssetDocumentCommand implements EditCommand<Record<string, unknown>> {
  readonly type = "asset.setDocument";
  readonly from: Record<string, unknown>;
  readonly to: Record<string, unknown>;
  readonly mergeKey?: string;

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
    return new SetAssetDocumentCommand(this.to, this.from);
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
