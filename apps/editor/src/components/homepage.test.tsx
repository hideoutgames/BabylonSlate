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

  it("offers a built-in 2D Create Project card next to Empty", async () => {
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
    screen.getByTestId("create-project").click();
    expect(await screen.findByTestId("create-project-empty")).toBeTruthy();
    expect(screen.getByTestId("create-project-2d")).toBeTruthy();
    expect(screen.getByTestId("create-project-width")).toBeTruthy();
    expect(screen.getByTestId("create-project-height")).toBeTruthy();
    expect(screen.getByTestId("create-project-black-bars")).toBeTruthy();
  });
});
