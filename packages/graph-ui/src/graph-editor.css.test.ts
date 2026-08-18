import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "graph-editor.css"),
  "utf8",
);

describe("anim-state side handles", () => {
  it("clears xyflow handle transforms so stretched sides stay on the node", () => {
    const block = css.match(/\.anim-state-handle\s*\{[^}]+\}/)?.[0];
    expect(block).toMatch(/transform:\s*none/);
  });
});
