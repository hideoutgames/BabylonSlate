import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeGoldenText,
  readGolden,
  writeGolden,
} from "@babylonslate/test-kit";
import { packRectangles } from "./sprite-packer";
import { packedRectsToFrames } from "./sprite-payload";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("sprite rectangle packer", () => {
  it("is deterministic and keeps padding between frames", () => {
    const frames = [
      { id: "b", width: 8, height: 8 },
      { id: "a", width: 16, height: 8 },
      { id: "c", width: 8, height: 16 },
    ];
    const first = packRectangles(frames, { padding: 2, extrusion: 1 });
    const second = packRectangles(frames, { padding: 2, extrusion: 1 });
    expect(first).toEqual(second);
    expect(first.rects.map((rect) => rect.id)).toEqual(["c", "a", "b"]);
    const serialized = `${JSON.stringify(
      { pack: first, frames: packedRectsToFrames(first) },
      null,
      2,
    )}\n`;
    const relative = "__fixtures__/sprite-pack.golden.json";
    if (UPDATE) {
      writeGolden(FIXTURE_DIR, relative, serialized);
    }
    expect(normalizeGoldenText(serialized)).toBe(
      normalizeGoldenText(readGolden(FIXTURE_DIR, relative)),
    );
  });
});
