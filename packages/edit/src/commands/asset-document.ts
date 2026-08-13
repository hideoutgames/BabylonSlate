import type { EditCommand } from "../command";

export class SetAssetDocumentCommand implements EditCommand<Record<string, unknown>> {
  readonly type = "asset.setDocument";
  readonly from: Record<string, unknown>;
  readonly to: Record<string, unknown>;

  constructor(from: Record<string, unknown>, to: Record<string, unknown>) {
    this.from = from;
    this.to = to;
  }

  apply(_doc?: Record<string, unknown>): Record<string, unknown> {
    return structuredClone(this.to);
  }

  invert(): SetAssetDocumentCommand {
    return new SetAssetDocumentCommand(this.to, this.from);
  }
}

export function createSetAssetDocumentCommandFromJson(
  payload: Record<string, unknown>,
): SetAssetDocumentCommand {
  return new SetAssetDocumentCommand(
    (payload.from ?? {}) as Record<string, unknown>,
    (payload.to ?? {}) as Record<string, unknown>,
  );
}
