import { describe, expect, it, vi } from "vitest";
import {
  defaultEngineSettings,
  type AppSettingsStore,
} from "@babylonslate/vfs";
import { AppSettingsOwner } from "./app-settings-context";

describe("AppSettingsOwner", () => {
  it("keeps an update authoritative when delayed hydration completes", async () => {
    const loaded = defaultEngineSettings();
    loaded.viewportFlySpeed = 4;
    let finishLoad: ((settings: typeof loaded) => void) | undefined;
    const store: AppSettingsStore = {
      load: vi.fn(
        () =>
          new Promise<typeof loaded>((resolve) => {
            finishLoad = resolve;
          }),
      ),
      save: vi.fn(),
      update: vi.fn(),
    };
    const owner = new AppSettingsOwner(store);
    const seen: number[] = [];
    const alsoSeen: number[] = [];
    owner.subscribe(({ settings }) => seen.push(settings.viewportFlySpeed));
    owner.subscribe(({ settings }) => alsoSeen.push(settings.viewportFlySpeed));

    const hydration = owner.hydrate();
    owner.receiveUpdate({ viewportFlySpeed: 12 });
    finishLoad?.(loaded);
    await hydration;

    expect(owner.getSnapshot().settings.viewportFlySpeed).toBe(12);
    expect(seen.at(-1)).toBe(12);
    expect(alsoSeen.at(-1)).toBe(12);
    expect(owner.getSnapshot().version).toBe(1);
  });
});
