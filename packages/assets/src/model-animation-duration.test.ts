import { expect, it } from "vitest";
import { encodeGlbJsonBin } from "./importers/glb-parse";
import { resolveModelAnimationDurations } from "./model-animation-duration";

it("repairs offset take durations for existing native and retargeted assets, preserving unknown clips and sprites", () => {
  const bytes = encodeGlbJsonBin(
    {
      animations: [{ name: "Run", samplers: [{ input: 0 }] }],
      accessors: [{ min: [59], max: [60] }],
    },
    new Uint8Array(),
  );
  const catalog = [
    {
      guid: "native",
      type: "Animation",
      modelGuid: "source",
      clipName: "Run",
      durationMs: 60000,
    },
    {
      guid: "retarget",
      type: "Animation",
      modelGuid: "target",
      clipName: "Run",
      durationMs: 60000,
    },
    {
      guid: "unknown",
      type: "Animation",
      modelGuid: "source",
      clipName: "Missing",
      durationMs: 500,
    },
    {
      guid: "sprite",
      type: "SpriteAnimation",
      modelGuid: "source",
      clipName: "Run",
      durationMs: 900,
    },
  ];
  expect(
    resolveModelAnimationDurations(
      catalog,
      new Map([["source", bytes]]),
      new Map([
        [
          "target",
          [
            {
              animationGuid: "retarget",
              sourceModelGuid: "source",
              clipName: "Run",
            },
          ],
        ],
      ]),
    ).map((entry) => entry.durationMs),
  ).toEqual([1000, 1000, 500, 900]);
  expect(catalog[0]!.durationMs).toBe(60000);
});
