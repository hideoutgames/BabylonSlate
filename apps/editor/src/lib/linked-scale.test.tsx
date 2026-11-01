import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PropertyGrid } from "@haptic/editor-kit";
import { MemoryAppSettingsStore } from "@haptic/vfs";
import { AppSettingsProvider } from "../context/app-settings-context";
import { scaleLinkKey, useLinkedScale } from "./linked-scale";

function ScaleRows({ actorIds }: { actorIds: string[] }) {
  const linkedScale = useLinkedScale();
  return (
    <PropertyGrid
      rows={actorIds.map((id) => ({
        kind: "vector3",
        id,
        label: `${id} Scale`,
        value: [1, 2, 3],
        ...linkedScale.link(scaleLinkKey.actor(id)),
        onChange: () => {},
      }))}
    />
  );
}

describe("useLinkedScale", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts each Scale unlinked and remembers each one's link on this device", async () => {
    const store = new MemoryAppSettingsStore();
    const inspector = () => (
      <AppSettingsProvider store={store}>
        <ScaleRows actorIds={["Alpha", "Beta"]} />
      </AppSettingsProvider>
    );
    const link = (id: string) => screen.getByRole("button", { name: `Link ${id} Scale Axes` });
    const first = render(inspector());
    await act(async () => {});
    expect(link("Alpha").getAttribute("aria-pressed")).toBe("false");
    expect(link("Beta").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(link("Alpha"));
    await waitFor(() => expect(link("Alpha").getAttribute("aria-pressed")).toBe("true"));
    expect(link("Beta").getAttribute("aria-pressed")).toBe("false");
    first.unmount();

    render(inspector());
    await waitFor(() => expect(link("Alpha").getAttribute("aria-pressed")).toBe("true"));
    expect(link("Beta").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(link("Alpha"));
    await waitFor(() => expect(link("Alpha").getAttribute("aria-pressed")).toBe("false"));
    expect((await store.load()).linkedScaleKeys).toEqual([]);
  });
});
