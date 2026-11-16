import { describe, expect, it } from "vitest";
import { relate, type CommitNode } from "./history";

/** A history from `child: parents` lines; timestamps follow the order commits are listed (later = newer). */
function graph(lines: string[]): { read: (oid: string) => Promise<CommitNode | null>; reads: string[] } {
  const nodes = new Map<string, CommitNode>();
  lines.forEach((line, index) => {
    const [oid, parents = ""] = line.split(":").map((part) => part.trim());
    nodes.set(oid!, { parents: parents ? parents.split(" ") : [], timestamp: index });
  });
  const reads: string[] = [];
  return {
    reads,
    read: async (oid) => {
      reads.push(oid);
      return nodes.get(oid) ?? null;
    },
  };
}

const sorted = (relation: { ahead: string[]; behind: string[] }) => ({ ahead: [...relation.ahead].sort(), behind: [...relation.behind].sort() });

describe("relate", () => {
  it.each([
    { name: "same commit", local: "B", remote: "B", base: "B", ahead: [], behind: [] },
    { name: "remote ahead", local: "B", remote: "D", base: "B", ahead: [], behind: ["C", "D"] },
    { name: "local ahead", local: "D", remote: "B", base: "B", ahead: ["C", "D"], behind: [] },
    { name: "diverged", local: "X", remote: "D", base: "B", ahead: ["X"], behind: ["C", "D"] },
    { name: "merged remote into local", local: "M", remote: "D", base: "D", ahead: ["M", "X"], behind: [] },
  ])("$name", async ({ local, remote, base, ahead, behind }) => {
    const { read } = graph(["A", "B: A", "C: B", "D: C", "X: B", "M: X D"]);
    const relation = await relate(local, [remote], read, new Set());
    expect(relation.base).toBe(base);
    expect(sorted(relation)).toEqual({ ahead, behind });
    expect(relation.truncated).toBe(false);
  });

  it("reads only the commits since the fork", async () => {
    const lines = ["A", ...Array.from({ length: 50 }, (_, index) => `H${index}: ${index === 0 ? "A" : `H${index - 1}`}`), "L: H49", "R: H49"];
    const { read, reads } = graph(lines);
    expect(await relate("L", ["R"], read, new Set())).toMatchObject({ base: "H49", ahead: ["L"], behind: ["R"] });
    expect(reads).not.toContain("H40");
  });

  it("lists each side newest first, so the newest incoming commits are the first ones", async () => {
    // The remote merged a branch whose older commit P comes first in M's parents.
    const { read } = graph(["A", "P: A", "Q: A", "R: Q", "M: P R", "L: A"]);
    const relation = await relate("L", ["M"], read, new Set());
    expect(relation.behind).toEqual(["M", "R", "Q", "P"]);
    expect(relation.ahead).toEqual(["L"]);
  });

  it("counts every local commit when nothing was pushed yet", async () => {
    const { read } = graph(["A", "B: A", "C: B"]);
    expect(sorted(await relate("C", [], read, new Set()))).toEqual({ ahead: ["A", "B", "C"], behind: [] });
  });

  it("counts an unpushed branch against every remote branch, so only commits none of them holds are ahead", async () => {
    // F branches from main's B; the remote holds main (D) and art (Y, also from B).
    const { read } = graph(["A", "B: A", "C: B", "D: C", "Y: B", "F1: B", "F2: F1"]);
    const relation = await relate("F2", ["D", "Y"], read, new Set());
    expect(relation.base).toBe("B");
    expect(sorted(relation)).toEqual({ ahead: ["F1", "F2"], behind: ["C", "D", "Y"] });
  });

  it("reports a fork older than a shallow copy's history as truncated, with no base", async () => {
    // B is the shallow boundary: its parent A is not in this copy.
    const { read } = graph(["B: A", "X: B", "C: Q", "R: C"]);
    const relation = await relate("X", ["R"], read, new Set(["B"]));
    expect(relation).toMatchObject({ base: null, truncated: true });
    expect(sorted(relation)).toEqual({ ahead: ["B", "X"], behind: ["C", "R"] });
  });
});
