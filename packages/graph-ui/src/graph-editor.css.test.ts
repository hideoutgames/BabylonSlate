import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "graph-editor.css"),
  "utf8",
);

function rule(selector: string): string {
  const block = css.match(new RegExp(`${selector}\\s*\\{[^}]+\\}`))?.[0];
  expect(block, selector).toBeTruthy();
  return block ?? "";
}

describe("anim-state side handles", () => {
  it("clears xyflow handle transforms so stretched sides stay on the node", () => {
    expect(rule("\\.anim-state-handle")).toMatch(/transform:\s*none/);
  });

  it("uses a large state body so the interior can be dragged", () => {
    const block = rule("\\.anim-state-node");
    expect(block).toMatch(/min-width:\s*200px/);
    expect(block).toMatch(/min-height:\s*88px/);
  });

  it("keeps side handle plates thinner than the touch-target so they do not cover the body", () => {
    const top = rule("\\.anim-state-handle-top");
    const left = rule("\\.anim-state-handle-left");
    expect(top).not.toMatch(/--touch-target/);
    expect(left).not.toMatch(/--touch-target/);
    expect(top).toMatch(/height:\s*16px/);
    expect(top).toMatch(/width:\s*calc\(100% - 28px\)/);
    expect(left).toMatch(/width:\s*16px/);
    expect(left).toMatch(/height:\s*calc\(100% - 28px\)/);
  });

  it("paints a geometric tick on source side handles", () => {
    expect(css).toMatch(/\.anim-state-handle-source::after/);
  });
});
