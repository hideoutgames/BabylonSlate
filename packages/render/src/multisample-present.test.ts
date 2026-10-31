import { Constants } from "@babylonjs/core/Engines/constants";
import { describe, expect, it } from "vitest";
import { presentsMultisampleByBlit, type MultisamplePresentInputs } from "./multisample-present";

const direct: MultisamplePresentInputs = {
  webGl2: true, samples: 4, colorType: Constants.TEXTURETYPE_UNSIGNED_BYTE, backbuffer: true, outputSized: true, laterReaders: false,
};

describe("presentsMultisampleByBlit", () => {
  it("blits a multisampled WebGL2 world view straight to a same-size backbuffer", () => {
    expect(presentsMultisampleByBlit(direct)).toBe(true);
    expect(presentsMultisampleByBlit({ ...direct, samples: 2 })).toBe(true);
  });

  it("keeps the resolve and the output copy wherever the blit cannot stand in for them", () => {
    for (const change of [
      { webGl2: false }, // WebGPU resolves in the render pass
      { samples: 1 },
      { colorType: Constants.TEXTURETYPE_HALF_FLOAT }, // a multisampled blit needs the backbuffer's format
      { backbuffer: false },
      { outputSized: false }, // a multisampled blit cannot scale
      { laterReaders: true }, // outlines or the water scene copy read the resolve
    ] satisfies Partial<MultisamplePresentInputs>[])
      expect(presentsMultisampleByBlit({ ...direct, ...change }), JSON.stringify(change)).toBe(false);
  });
});
