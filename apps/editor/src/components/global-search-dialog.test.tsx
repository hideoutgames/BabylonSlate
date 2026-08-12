import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { SearchEntry } from "@babylonslate/assets";
import { GlobalSearchDialog } from "./global-search-dialog";

const hits: SearchEntry[] = Array.from({ length: 40 }, (_, index) => ({
  id: `class:Hit${index}`,
  kind: "class",
  label: `Hit ${index}`,
  keywords: ["hit"],
  target: { kind: "class", classId: `Hit${index}` },
}));

vi.mock("../context/project-search-context", () => ({
  useProjectSearch: () => ({
    query: (needle: string) => (needle.trim() ? hits : []),
    pendingTarget: null,
    clearPendingTarget: () => {},
    openSearchResult: async () => {},
  }),
}));

afterEach(() => {
  cleanup();
});

describe("GlobalSearchDialog", () => {
  it("uses a fixed tall height and a native overflow results pane", () => {
    const { getByTestId } = render(
      <GlobalSearchDialog open onOpenChange={() => {}} />,
    );

    const dialog = getByTestId("global-search-dialog");
    expect(dialog.className).toContain("h-[min(90svh,52rem)]");
    expect(dialog.className).toContain("overflow-hidden");
    expect(dialog.className).not.toContain("max-h-[min(80svh,40rem)]");

    const results = getByTestId("global-search-results");
    expect(results.className).toContain("min-h-0");
    expect(results.className).toContain("flex-1");
    expect(results.className).toContain("overflow-y-auto");
  });

  it("renders many hits inside the scrollable results pane", () => {
    const { getByTestId } = render(
      <GlobalSearchDialog open onOpenChange={() => {}} />,
    );

    fireEvent.change(getByTestId("global-search-query"), {
      target: { value: "hit" },
    });

    const results = getByTestId("global-search-results");
    expect(getByTestId("global-search-group-class")).toBeTruthy();
    expect(results.querySelectorAll('[data-testid^="global-search-item-"]').length).toBe(
      40,
    );
  });
});
