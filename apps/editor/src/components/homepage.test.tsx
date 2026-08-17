import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ListedProject } from "../lib/listed-projects";
import { Homepage } from "./homepage";

const { getHostPlatform } = vi.hoisted(() => ({
  getHostPlatform: vi.fn(() => "web"),
}));

vi.mock("@babylonslate/vfs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/vfs")>();
  return { ...actual, getHostPlatform };
});

vi.mock("./settings-modal", () => ({
  SettingsModal: () => null,
}));

afterEach(() => {
  cleanup();
  getHostPlatform.mockReturnValue("web");
});

const noop = async () => {};

function renderHomepage(
  overrides: Partial<ComponentProps<typeof Homepage>> = {},
) {
  return render(
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
      {...overrides}
    />,
  );
}

function listedProject(
  name: string,
  tier: ListedProject["tier"],
): ListedProject {
  return { id: `${tier}:${name}`, name, tier, label: name };
}

describe("Homepage branding", () => {
  it("shows the Slate wordmark in the header", () => {
    renderHomepage();

    expect(screen.getByTestId("brand-logo")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "BabylonSlate" })).toBeTruthy();
  });

  it("offers a built-in 2D Create Project card next to Empty", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    expect(await screen.findByTestId("create-project-empty")).toBeTruthy();
    expect(screen.getByTestId("create-project-2d")).toBeTruthy();
    expect(screen.getByTestId("create-project-width")).toBeTruthy();
    expect(screen.getByTestId("create-project-height")).toBeTruthy();
    expect(screen.getByTestId("create-project-black-bars")).toBeTruthy();
  });
});

describe("Homepage Create Project copy", () => {
  it("sells Empty and 2D on web instead of an unavailable templates folder", () => {
    renderHomepage();
    const description = screen.getByTestId("create-project-description");
    expect(description.textContent).toMatch(/Empty/);
    expect(description.textContent).toMatch(/2D/);
    expect(description.textContent).not.toMatch(/not available on web/i);
    expect(description.textContent).not.toMatch(/templates folder/i);
    expect(description.textContent).not.toMatch(/Engine Settings/);
    expect(screen.getByTestId("create-project")).toBeTruthy();
  });

  it("mentions Engine Settings templates only as an optional extra on native", () => {
    getHostPlatform.mockReturnValue("ios");
    renderHomepage();
    const description = screen.getByTestId("create-project-description");
    expect(description.textContent).toMatch(/Empty/);
    expect(description.textContent).toMatch(/2D/);
    expect(description.textContent).toMatch(/Engine Settings/);
    expect(description.textContent).toMatch(/optional/i);
    expect(description.textContent).not.toMatch(/not available on web/i);
  });
});

describe("Homepage recent project rows", () => {
  it("does not show storage API names when every listed project is the same tier", () => {
    renderHomepage({
      projects: [
        listedProject("Game.babproject", "opfs"),
        listedProject("Other.babproject", "opfs"),
      ],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.textContent).toMatch(/Game/);
    expect(row.textContent).not.toMatch(/opfs|idb|documents|external/i);
    expect(row.textContent).not.toMatch(/On this device/);
  });

  it("labels a picked folder without storage API names", () => {
    renderHomepage({
      projects: [
        listedProject("Game.babproject", "opfs"),
        listedProject("Studio.babproject", "external"),
      ],
    });
    const device = screen.getByTestId("open-listed-project-Game.babproject");
    const folder = screen.getByTestId("open-listed-project-Studio.babproject");
    expect(device.textContent).toMatch(/On this device/);
    expect(folder.textContent).toMatch(/Chosen folder/);
    expect(device.textContent).not.toMatch(/opfs|idb/i);
    expect(folder.textContent).not.toMatch(/external|idb/i);
  });
});

describe("Homepage Create Project dialog", () => {
  it("shows Name required and disables Create when Name is empty", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const name = await screen.findByTestId("create-project-name");
    fireEvent.change(name, { target: { value: "" } });
    expect(screen.getByTestId("create-project-name-issue").textContent).toBe(
      "Name required.",
    );
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows Name already exists and disables Create on a listed name", async () => {
    renderHomepage({
      projects: [listedProject("MyGame.babproject", "opfs")],
    });
    screen.getByTestId("create-project").click();
    expect(
      (await screen.findByTestId("create-project-name-issue")).textContent,
    ).toBe("Name already exists.");
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("drops template copy, says On this device, and explains Black Bars", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const dialog = await screen.findByTestId("create-project-dialog");
    expect(dialog.textContent).not.toMatch(/or a template/i);
    expect(screen.getByTestId("create-project-location").textContent).toBe(
      "On this device.",
    );
    expect(dialog.textContent).toMatch(/letterboxes/i);
  });
});
