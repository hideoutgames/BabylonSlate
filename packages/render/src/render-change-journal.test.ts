import { afterEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { noteRenderChange, openRenderChangeReader, renderChangeJournalStats } from "./render-change-journal";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function scene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

describe("renderChangeJournalStats", () => {
  it("is null for a Scene without a reader, then tells the entries and how far the slowest reader is behind", () => {
    const target = scene();
    const nodes = [new TransformNode("a", target), new TransformNode("b", target), new TransformNode("c", target)];
    expect(renderChangeJournalStats(target)).toBeNull();
    const fast = openRenderChangeReader(target);
    const slow = openRenderChangeReader(target);
    for (const node of nodes) noteRenderChange(node);
    expect(renderChangeJournalStats(target)).toEqual({ entries: 3, readers: 2, maxLag: 3 });
    fast.drain(() => {});
    // The undrained reader keeps every entry and is three behind.
    expect(renderChangeJournalStats(target)).toEqual({ entries: 3, readers: 2, maxLag: 3 });
    slow.drain(() => {});
    expect(renderChangeJournalStats(target)).toEqual({ entries: 0, readers: 2, maxLag: 0 });
    fast.dispose();
    slow.dispose();
    expect(renderChangeJournalStats(target)).toBeNull();
  });
});
