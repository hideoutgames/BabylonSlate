import { describe, expect, it } from "vitest";
import { defaultAppId, isValidAppId, normalizeAppIdentity, resolvedAppIdentity } from "./app-identity";

describe("App identity", () => {
  it("accept only app IDs Apple and Android both accept", () => {
    for (const id of ["com.studio.game", "no.hideout.Space2"]) expect(isValidAppId(id)).toBe(true);
    // Hyphens break Android package names, underscores Apple bundle IDs; one part is neither.
    for (const id of ["com.my-studio.game", "com.my_studio.game", "game", "com.2studio.game", "com..game", ".com.game"]) expect(isValidAppId(id)).toBe(false);
  });

  it("fill blanks from the project and keep a stored identity only when valid", () => {
    expect(defaultAppId("Space Game 2")).toBe("com.example.spacegame2");
    expect(defaultAppId("2048")).toBe("com.example.game");
    expect(resolvedAppIdentity(normalizeAppIdentity(undefined), "Space Game")).toEqual({ appId: "com.example.spacegame", displayName: "Space Game", buildNumber: 1 });
    expect(normalizeAppIdentity({ appId: "com.bad-id.x", displayName: " Rocket ", buildNumber: 0 })).toEqual({ appId: "", displayName: "Rocket", buildNumber: 1 });
    expect(normalizeAppIdentity({ appId: "com.studio.rocket", buildNumber: 42 })).toMatchObject({ appId: "com.studio.rocket", buildNumber: 42 });
  });
});
