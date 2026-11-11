import { describe, expect, it } from "vitest";
import { appIconCrop, appIconSizeHint, defaultAppId, isValidAppId, normalizeAppIdentity, resolvedAppIdentity } from "./app-identity";

describe("App identity", () => {
  it("accept only app IDs Apple and Android both accept", () => {
    for (const id of ["com.studio.game", "no.hideout.Space2"]) expect(isValidAppId(id)).toBe(true);
    // Hyphens break Android package names, underscores Apple bundle IDs; one part is neither.
    for (const id of ["com.my-studio.game", "com.my_studio.game", "game", "com.2studio.game", "com..game", ".com.game"]) expect(isValidAppId(id)).toBe(false);
  });

  it("fill blanks from the project and keep a stored identity only when valid", () => {
    expect(defaultAppId("Space Game 2")).toBe("com.example.spacegame2");
    expect(defaultAppId("2048")).toBe("com.example.game");
    expect(resolvedAppIdentity(normalizeAppIdentity(undefined), "Space Game")).toEqual({ appId: "com.example.spacegame", displayName: "Space Game", buildNumber: 1, iconTextureGuid: null });
    expect(normalizeAppIdentity({ appId: "com.bad-id.x", displayName: " Rocket ", buildNumber: 0 })).toEqual({ appId: "", displayName: "Rocket", buildNumber: 1, iconTextureGuid: null });
    expect(normalizeAppIdentity({ appId: "com.studio.rocket", buildNumber: 42 })).toMatchObject({ appId: "com.studio.rocket", buildNumber: 42 });
  });

  it("keep the App Icon Texture, with a blank one meaning none", () => {
    expect(normalizeAppIdentity({ iconTextureGuid: " tex-icon " }).iconTextureGuid).toBe("tex-icon");
    for (const iconTextureGuid of ["", "  ", 7, null]) expect(normalizeAppIdentity({ iconTextureGuid }).iconTextureGuid).toBeNull();
  });

  it("cut the centre square of any App Icon source", () => {
    expect(appIconCrop({ width: 1024, height: 1024 })).toEqual({ x: 0, y: 0, edge: 1024 });
    expect(appIconCrop({ width: 1920, height: 1080 })).toEqual({ x: 420, y: 0, edge: 1080 });
    expect(appIconCrop({ width: 300, height: 501 })).toEqual({ x: 0, y: 100, edge: 300 });
  });

  it("note a cropped or scaled-up App Icon source without refusing it", () => {
    expect(appIconSizeHint({ width: 1024, height: 1024 })).toBeNull();
    expect(appIconSizeHint({ width: 4096, height: 4096 })).toBeNull();
    expect(appIconSizeHint({ width: 2048, height: 1024 })).toBe("This image is 2048 × 1024. The centre 1024 × 1024 is used.");
    expect(appIconSizeHint({ width: 1023, height: 1023 })).toBe("This image is 1023 × 1023. Icons up to 1024 × 1024 are scaled up and may look soft.");
    expect(appIconSizeHint({ width: 640, height: 480 })).toBe(
      "This image is 640 × 480. The centre 480 × 480 is used. Icons up to 1024 × 1024 are scaled up and may look soft.");
  });
});
