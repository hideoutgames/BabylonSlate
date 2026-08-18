import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SkeletonEditor, SkeletonPreview } from "./skeleton-editor";

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => null,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "model-1", name: "Hero", type: "Model" },
          path: "assets/Hero.babasset",
        },
      ],
    },
    readAssetChunk: async () => null,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("SkeletonEditor", () => {
  it("shows a read-only Model picker and inspect-only bone names", () => {
    render(
      <SkeletonEditor
        payload={{
          modelGuid: "model-1",
          kind: "hierarchy",
          boneNames: ["torso", "arm-left"],
        }}
      />,
    );
    expect(screen.getByTestId("skeleton-editor")).toBeTruthy();
    expect(screen.getByTestId("property-kind")).toHaveProperty("disabled", true);
    expect((screen.getByTestId("property-kind") as HTMLInputElement).value).toBe(
      "Hierarchy",
    );
    expect(screen.getByTestId("property-model").textContent).toContain("Hero");
    expect(screen.getByTestId("skeleton-bone-tree").textContent).toContain(
      "torso",
    );
    expect(screen.getByTestId("skeleton-bone-tree").textContent).toContain(
      "arm-left",
    );
  });
});

describe("SkeletonPreview", () => {
  it("shows an empty state without a glTF source", () => {
    render(
      <SkeletonPreview
        payload={{
          modelGuid: "model-1",
          kind: "hierarchy",
          boneNames: ["torso"],
        }}
      />,
    );
    expect(screen.getByTestId("skeleton-preview").textContent).toMatch(/No Mesh/);
  });
});
