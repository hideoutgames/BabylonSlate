/** Change together with measured rollout evidence and required GitHub check contexts. */
export const verificationPolicy = { e2eShards: 7, readyPrSlots: 2 };
export const requiredVerifyJobs = [
  "static",
  "unit",
  ...Array.from(
    { length: verificationPolicy.e2eShards },
    (_, i) => `e2e (${i + 1})`,
  ),
];
