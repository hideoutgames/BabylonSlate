import { describe, expect, it } from "vitest";
import { playerHostBase, playerPreviewSrc } from "./player-host-url";

describe("playerHostBase", () => {
  it("serves the player from the site root by default", () => {
    expect(playerHostBase("/")).toBe("/player/");
  });

  it("keeps the player under a deployed sub-path", () => {
    expect(playerHostBase("/BabylonSlate/")).toBe("/BabylonSlate/player/");
  });

  it("tolerates a base without a trailing slash", () => {
    expect(playerHostBase("/BabylonSlate")).toBe("/BabylonSlate/player/");
  });

  it("falls back to the root when the base is empty", () => {
    expect(playerHostBase("")).toBe("/player/");
  });
});

describe("playerPreviewSrc", () => {
  it("requests preview mode and busts the iframe cache", () => {
    expect(playerPreviewSrc(1234, "/BabylonSlate/")).toBe(
      "/BabylonSlate/player/index.html?preview=1&t=1234",
    );
  });
});
