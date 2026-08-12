import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Homepage } from "./homepage";

vi.mock("./settings-modal", () => ({
  SettingsModal: () => null,
}));

afterEach(() => {
  cleanup();
});

const noop = async () => {};

describe("Homepage branding", () => {
  it("shows the Slate wordmark in the header", () => {
    render(
      <Homepage
        projects={[]}
        templates={[]}
        needsReconnect={false}
        recoveryAvailable={false}
        onCreateEmpty={noop}
        onCreateFromTemplate={noop}
        onOpenExternal={noop}
        onOpenProject={noop}
        onRenameProject={noop}
        onRemoveFromList={noop}
        onReconnect={noop}
        onRecover={noop}
        onDismissRecovery={() => {}}
        onSettingsChanged={noop}
      />,
    );

    expect(screen.getByTestId("brand-logo")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "BabylonSlate" })).toBeTruthy();
  });
});
