/**
 * How often a Mirror or an every-frame Render Target Capture redraws in Play. A surface on a reduced rate keeps showing
 * its last image on the frames it skips; the editor viewport always draws at Every Frame.
 */
export const UPDATE_RATES = ["everyFrame", "every2ndFrame", "every4thFrame"] as const;
export type UpdateRate = (typeof UPDATE_RATES)[number];
export const UPDATE_RATE_LABELS: Record<UpdateRate, string> = {
  everyFrame: "Every Frame",
  every2ndFrame: "Every 2nd Frame",
  every4thFrame: "Every 4th Frame",
};

/** Frames between draws at `rate`: 1, 2 or 4. */
export function updateRateInterval(rate: UpdateRate): number {
  return rate === "every4thFrame" ? 4 : rate === "every2ndFrame" ? 2 : 1;
}

/** A known rate, or Every Frame for an absent or unknown value. */
export function normalizeUpdateRate(value: unknown): UpdateRate {
  return (UPDATE_RATES as readonly unknown[]).includes(value) ? value as UpdateRate : "everyFrame";
}
