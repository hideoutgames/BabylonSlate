import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

// Two copies of React, its types, TypeScript or Babylon.js in one install break at run time or type check in ways no
// single workspace's tests see (two React dispatchers, two Babylon engines registering the same classes).

/** `{ name: [versions] }` of every package the lockfile resolves (its `packages` section keys: `name@version`). */
function resolvedVersions(lockfile) {
  const versions = new Map();
  for (const key of Object.keys(lockfile.packages ?? {})) {
    const at = key.indexOf("@", 1);
    if (at < 1) throw new Error(`Unexpected lockfile package key: ${key}`);
    const name = key.slice(0, at);
    versions.set(name, [...new Set([...(versions.get(name) ?? []), key.slice(at + 1)])].sort());
  }
  return versions;
}

const SINGLE = ["react", "react-dom", "@types/react", "@types/react-dom", "typescript", "@babylonjs/core"];

/** Problems with the guarded packages: each resolves once, and every Babylon.js package built on core matches it. */
function versionProblems(lockfile) {
  const versions = resolvedVersions(lockfile);
  const problems = [];
  const babylon = [...versions.keys()].filter((name) => name.startsWith("@babylonjs/"));
  for (const name of [...new Set([...SINGLE, ...babylon])]) {
    const found = versions.get(name) ?? [];
    if (found.length !== 1) problems.push(`${name} resolves to ${found.length ? found.join(", ") : "nothing"}`);
  }
  // Packages that extend core (loaders, serializers, ...) peer-depend on it and ship in lockstep with it; separately
  // versioned ones such as the Havok physics binary do not.
  const [core] = versions.get("@babylonjs/core") ?? [];
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    const at = key.indexOf("@", 1);
    const name = key.slice(0, at);
    if (name.startsWith("@babylonjs/") && entry?.peerDependencies?.["@babylonjs/core"] && key.slice(at + 1) !== core)
      problems.push(`${key} extends @babylonjs/core but core resolves to ${core}`);
  }
  return problems;
}

test("lockfile keys give each package's resolved versions", () => {
  const versions = resolvedVersions({
    packages: {
      "react@19.2.8": {},
      "react@18.3.1": {},
      "@types/react@19.2.18": {},
      "@babylonjs/core@9.29.0": {},
    },
  });
  assert.deepEqual(Object.fromEntries(versions), {
    react: ["18.3.1", "19.2.8"],
    "@types/react": ["19.2.18"],
    "@babylonjs/core": ["9.29.0"],
  });
});

test("a second copy of a guarded package, or a Babylon.js extension off core's version, is reported", () => {
  const packages = {
    "react@19.2.8": {},
    "react-dom@19.2.8": {},
    "@types/react@19.2.18": {},
    "@types/react-dom@19.2.4": {},
    "typescript@6.0.3": {},
    "@babylonjs/core@9.29.0": {},
    "@babylonjs/loaders@9.29.0": { peerDependencies: { "@babylonjs/core": "^9.0.0" } },
    "@babylonjs/havok@1.3.14": {},
  };
  assert.deepEqual(versionProblems({ packages }), []);
  assert.deepEqual(versionProblems({ packages: { ...packages, "typescript@5.9.3": {} } }), [
    "typescript resolves to 5.9.3, 6.0.3",
  ]);
  assert.deepEqual(versionProblems({ packages: { ...packages, "@babylonjs/havok@1.3.15": {} } }), [
    "@babylonjs/havok resolves to 1.3.14, 1.3.15",
  ]);
  assert.deepEqual(
    versionProblems({
      packages: { ...packages, "@babylonjs/gui@9.28.0": { peerDependencies: { "@babylonjs/core": "^9.0.0" } } },
    }),
    ["@babylonjs/gui@9.28.0 extends @babylonjs/core but core resolves to 9.29.0"],
  );
  const withoutDom = { ...packages };
  delete withoutDom["react-dom@19.2.8"];
  assert.deepEqual(versionProblems({ packages: withoutDom }), ["react-dom resolves to nothing"]);
});

test("the lockfile resolves one React, React DOM, their types, TypeScript and Babylon.js", async () => {
  const lockfile = parse(await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
  assert.deepEqual(versionProblems(lockfile), []);
});
