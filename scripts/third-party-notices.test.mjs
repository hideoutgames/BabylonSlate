import test from "node:test";
import assert from "node:assert/strict";
import {
  EDITOR_NOTICES_PATH,
  GAME_NOTICES_PATH,
  generateThirdPartyNotices,
  staleThirdPartyNotices,
} from "./third-party-notices.mjs";

const generated = generateThirdPartyNotices();

test("committed third-party notices match the installed dependencies", () => {
  assert.deepEqual(
    staleThirdPartyNotices(generated),
    [],
    "Run node scripts/third-party-notices.mjs and commit the result.",
  );
});

test("exported games carry the notices of their physics and texture runtimes", () => {
  const game = generated.get(GAME_NOTICES_PATH);
  for (const name of ["@babylonjs/core", "@babylonjs/havok", "@dimforge/rapier2d-deterministic-compat", "Babylon.js KTX2 Decoder"]) {
    assert.match(game, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} `, "m"), name);
  }
  assert.doesNotMatch(game, /^react /m, "editor-only packages stay out of games");
  assert.doesNotMatch(game, /^@revenuecat\//m, "packages the player depends on but never bundles stay out of games");
});

test("the editor list marks what also ships in games", () => {
  const { packages, texts } = JSON.parse(generated.get(EDITOR_NOTICES_PATH));
  const byName = new Map(packages.map(entry => [entry.name, entry]));
  assert.equal(byName.get("react")?.inGames, false);
  assert.equal(byName.get("@babylonjs/havok")?.inGames, true);
  assert.equal(byName.get("Basis Universal encoder")?.inGames, false);
  assert.equal(byName.get("@revenuecat/purchases-capacitor")?.inGames, false);
  for (const entry of packages) assert.ok(texts[entry.text]?.length > 0, entry.name);
});
