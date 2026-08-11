/**
 * A16 encode benchmark fixtures and checked-in expected envelopes
 * (engineplan §3.5 Risk 1). Wall times are soft bands; CI asserts shape and
 * that settings remain UASTC defaults. Device A16 numbers gate policy.
 */

export interface EncodeFixtureSpec {
  size: 512 | 1024 | 2048 | 4096;
  format: "png" | "jpeg";
  /** Soft upper bound wall ms on A16 (checked-in baseline). */
  a16WallMsMax: number;
  /** Soft upper bound worker heap MB on A16. */
  a16HeapMbMax: number;
}

export const A16_ENCODE_FIXTURES: EncodeFixtureSpec[] = [
  { size: 512, format: "png", a16WallMsMax: 2_000, a16HeapMbMax: 64 },
  { size: 1024, format: "png", a16WallMsMax: 5_000, a16HeapMbMax: 96 },
  { size: 2048, format: "png", a16WallMsMax: 10_000, a16HeapMbMax: 160 },
  { size: 4096, format: "png", a16WallMsMax: 30_000, a16HeapMbMax: 256 },
  { size: 512, format: "jpeg", a16WallMsMax: 2_000, a16HeapMbMax: 64 },
  { size: 1024, format: "jpeg", a16WallMsMax: 5_000, a16HeapMbMax: 96 },
  { size: 2048, format: "jpeg", a16WallMsMax: 10_000, a16HeapMbMax: 160 },
  { size: 4096, format: "jpeg", a16WallMsMax: 30_000, a16HeapMbMax: 256 },
];

/** Policy derived from A16 envelopes: reject native 4096 without confirm. */
export const A16_POLICY = {
  defaultMaxDimension: 2048,
  requireConfirmAboveDimension: 4096,
  defaultFormat: "uastc" as const,
  mainThreadMedianMsMaxDuringEncode: 1,
};

export function fixtureId(spec: EncodeFixtureSpec): string {
  return `${spec.size}-${spec.format}`;
}
