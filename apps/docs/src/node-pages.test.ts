import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
} from "@haptic/behaviour-tree";
import { PARTICLE_CATALOG } from "@haptic/particle-graph";
import { allNodeDefinitions } from "@haptic/scripting-nodes";
import { MATERIAL_CATALOG } from "@haptic/shader-graph";
import { scriptGraphFolder } from "./node-previews/catalog";
import { docsRoot, NODE_GRAPHS } from "./sidebar";

/** Every catalog node as `<graph folder>/<node id>`, the key node pages use. */
function catalogNodeKeys(): string[] {
  return [
    ...allNodeDefinitions().map((def) => `${scriptGraphFolder(def.id)}/${def.id}`),
    ...MATERIAL_CATALOG.map((def) => `material/${def.type}`),
    ...PARTICLE_CATALOG.map((def) => `particle/${def.type}`),
    ...[...BT_COMPOSITE_CATALOG, ...BT_TASK_CATALOG, ...BT_DECORATOR_CATALOG, ...BT_SERVICE_CATALOG].map(
      (entry) => `behaviour-tree/${entry.classId}`,
    ),
  ];
}

/** `<graph folder>/<node id>` for every node page, read from its `node:` frontmatter. */
function pageNodeKeys(): { keys: string[]; missing: string[] } {
  const keys: string[] = [];
  const missing: string[] = [];
  for (const { dir } of NODE_GRAPHS) {
    const graph = path.basename(dir);
    for (const file of readdirSync(path.join(docsRoot, dir))) {
      if (!file.endsWith(".md") || file === "index.md") continue;
      const text = readFileSync(path.join(docsRoot, dir, file), "utf8");
      const node = /^---\n(?:.*\n)*?node: "?([^"\n]+)"?\n(?:.*\n)*?---\n/.exec(text)?.[1];
      if (node) keys.push(`${graph}/${node}`);
      else missing.push(`${dir}/${file}`);
    }
  }
  return { keys, missing };
}

describe("node reference pages", () => {
  const pages = pageNodeKeys();
  const catalog = new Set(catalogNodeKeys());

  it("name their catalog node in node: frontmatter", () => {
    expect(pages.missing).toEqual([]);
    expect(pages.keys.filter((key) => !catalog.has(key))).toEqual([]);
  });

  it("exist once for every catalog node", () => {
    const documented = new Set(pages.keys);
    expect([...catalog].filter((key) => !documented.has(key))).toEqual([]);
    expect(pages.keys.length).toBe(documented.size);
  });
});
