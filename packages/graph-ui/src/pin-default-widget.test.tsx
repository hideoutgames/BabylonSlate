import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PinDefaultPreviewWidget } from "./pin-default-widget";
import { TagProvider } from "@babylonslate/editor-kit";

afterEach(() => {
  cleanup();
});

describe("PinDefaultPreviewWidget", () => {
  it("displays Tag paths instead of numeric IDs and identifies missing Tags", () => {
    render(<TagProvider entries={[
      { id: 1, path: "State", parentId: 0 },
      { id: 2, path: "State.Moving", parentId: 1 },
    ]}>
      <PinDefaultPreviewWidget preview={{ kind: "tag", value: 2 }} />
      <PinDefaultPreviewWidget preview={{ kind: "tag-container", value: { Tags: [1, 9] } }} />
    </TagProvider>);
    expect(screen.getByText("State.Moving")).toBeTruthy();
    expect(screen.getByText("State, Missing Tag")).toBeTruthy();
  });
});
