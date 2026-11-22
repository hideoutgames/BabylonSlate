import test from "node:test";
import assert from "node:assert/strict";
import {
  EDITOR_NOTICES_PATH,
  GAME_NOTICES_PATH,
  generateThirdPartyNotices,
  staleThirdPartyNotices,
  webSourceUrl,
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

test("repository addresses become the https page a browser opens", () => {
  const cases = [
    ["git@github.com:kaelzhang/node-ignore", "https://github.com/kaelzhang/node-ignore"],
    ["git@github.com:kaelzhang/node-ignore.git", "https://github.com/kaelzhang/node-ignore"],
    ["git+ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["ssh://git@gitlab.com:2222/group/repo.git", "https://gitlab.com/group/repo"],
    ["git+https://github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["git+https://user:secret@github.com/owner/repo.git#main", "https://github.com/owner/repo"],
    ["git://github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["github:owner/repo", "https://github.com/owner/repo"],
    ["gitlab:group/repo", "https://gitlab.com/group/repo"],
    ["bitbucket:team/repo", "https://bitbucket.org/team/repo"],
    ["owner/repo", "https://github.com/owner/repo"],
    ["https://github.com/owner/repo#readme", "https://github.com/owner/repo"],
    // A real web page stays as it is.
    ["https://github.com/BabylonJS/Assets/tree/master/core/areaLights", "https://github.com/BabylonJS/Assets/tree/master/core/areaLights"],
    ["https://example.com/docs/", "https://example.com/docs/"],
  ];
  for (const [address, expected] of cases) assert.equal(webSourceUrl(address), expected, address);
});

test("an address that is no https page gives no link", () => {
  for (const address of ["http://example.com/repo", "file:///tmp/repo", "gist:11081aaa281", "not an address", "", undefined]) {
    assert.equal(webSourceUrl(address), null, String(address));
  }
});

test("every generated source link is an https page", () => {
  const { packages } = JSON.parse(generated.get(EDITOR_NOTICES_PATH));
  for (const { name, source } of packages) {
    if (source) assert.equal(webSourceUrl(source), source, name);
  }
  assert.doesNotMatch(generated.get(GAME_NOTICES_PATH), /^Source: (?!https:\/\/)/m);
});
