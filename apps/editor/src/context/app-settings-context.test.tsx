import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PropertyGrid } from "@haptic/editor-kit";
import {
  defaultEngineSettings,
  MemoryAppSettingsStore,
  type AppSettingsStore,
} from "@haptic/vfs";
import { AppSettingsOwner, AppSettingsProvider } from "./app-settings-context";

describe("AppSettingsProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts the Scale link off and remembers it after the editor restarts", async () => {
    const store = new MemoryAppSettingsStore();
    const inspector = () => (
      <AppSettingsProvider store={store}>
        <PropertyGrid
          rows={[{ kind: "vector3", id: "scale", label: "Scale", value: [1, 2, 3], linkable: true, onChange: () => {} }]}
        />
      </AppSettingsProvider>
    );
    const link = () => screen.getByRole("button", { name: "Link Scale Axes" });
    const first = render(inspector());
    await act(async () => {});
    expect(link().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(link());
    await waitFor(() => expect(link().getAttribute("aria-pressed")).toBe("true"));
    expect((await store.load()).scaleAxesLinked).toBe(true);
    first.unmount();

    render(inspector());
    await waitFor(() => expect(link().getAttribute("aria-pressed")).toBe("true"));
  });
});

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

  it("publishes a stored settings event's whole appearance with its theme", () => {
    const store: AppSettingsStore = { load: vi.fn(), save: vi.fn(), update: vi.fn() };
    const owner = new AppSettingsOwner(store);
    const saved = defaultEngineSettings();
    saved.appearance = { theme: "dark", coarsePointerTargetScale: 1.5 };
    // Shape of the store's change event: every setting plus a top-level theme.
    owner.receiveUpdate({ ...saved, theme: saved.appearance.theme });
    expect(owner.getSnapshot().settings.appearance).toEqual({
      theme: "dark",
      coarsePointerTargetScale: 1.5,
    });

    owner.receiveUpdate({ theme: "light" });
    expect(owner.getSnapshot().settings.appearance).toEqual({
      theme: "light",
      coarsePointerTargetScale: 1.5,
    });
  });
});
