import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  useOpenAssetDocument,
  type AssetTabTarget,
} from "./use-open-asset-document";

const mocks = vi.hoisted(() => ({
  tabOrder: [] as string[],
  openDocument: vi.fn(),
  setActiveDocument: vi.fn(),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({ ...mocks }),
}));

function Harness({
  entry,
  onError,
}: {
  entry: AssetTabTarget;
  onError?: (message: string) => void;
}) {
  const open = useOpenAssetDocument({ onError });
  return (
    <button
      type="button"
      data-testid="go"
      onClick={() => void open(entry)}
    />
  );
}

const MATERIAL = { type: "Material", path: "assets/red.material.babasset" };

describe("useOpenAssetDocument", () => {
  beforeEach(() => {
    mocks.tabOrder = [];
    mocks.openDocument.mockReset().mockResolvedValue(undefined);
    mocks.setActiveDocument.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("focuses the existing tab when the document is already open", async () => {
    mocks.tabOrder = ["material:assets/red.material.babasset"];
    render(<Harness entry={MATERIAL} />);
    screen.getByTestId("go").click();
    await Promise.resolve();
    expect(mocks.setActiveDocument).toHaveBeenCalledWith(
      "material:assets/red.material.babasset",
    );
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it("opens a new document when no tab exists yet", async () => {
    render(<Harness entry={MATERIAL} />);
    screen.getByTestId("go").click();
    await Promise.resolve();
    expect(mocks.openDocument).toHaveBeenCalledWith({
      kind: "material",
      path: "assets/red.material.babasset",
      label: "red",
    });
    expect(mocks.setActiveDocument).not.toHaveBeenCalled();
  });

  it("does nothing for entries without a document kind or path", async () => {
    render(
      <Harness entry={{ type: "CameraComponent", path: "a/x.babasset" }} />,
    );
    screen.getByTestId("go").click();
    await Promise.resolve();
    expect(mocks.openDocument).not.toHaveBeenCalled();

    render(<Harness entry={{ type: "Material", path: "" }} />);
    screen.getAllByTestId("go")[1].click();
    await Promise.resolve();
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it("reports failures through onError instead of throwing", async () => {
    mocks.openDocument.mockRejectedValue(new Error("locked by teammate"));
    const onError = vi.fn();
    render(<Harness entry={MATERIAL} onError={onError} />);
    screen.getByTestId("go").click();
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("locked by teammate"),
    );
  });
});
