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
  it("shows the Slate icon mark and product name, not the wordmark", () => {
    renderHomepage();

    expect(screen.getByTestId("brand-icon")).toBeTruthy();
    expect(screen.queryByTestId("brand-logo")).toBeNull();
    expect(screen.getByRole("heading", { name: "BabylonSlate" })).toBeTruthy();
    expect(screen.getByTestId("engine-settings")).toBeTruthy();
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

describe("Homepage Start strip", () => {
  it("shows Empty, 2D, Open Folder, and Create Project on the Start strip", () => {
    renderHomepage();

    expect(screen.getByTestId("homepage-start")).toBeTruthy();
    expect(screen.getByTestId("homepage-start-empty")).toBeTruthy();
    expect(screen.getByTestId("homepage-start-2d")).toBeTruthy();
    expect(screen.getByTestId("open-project").textContent).toMatch(/Open Folder/i);
    expect(screen.getByTestId("create-project")).toBeTruthy();
  });

  it("gives Start template cards an image well", () => {
    renderHomepage();

    expect(
      screen
        .getByTestId("homepage-start-empty")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("homepage-start-2d")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
  });

  it("shows discovered templates in the Start strip", () => {
    renderHomepage({ templates: [{ id: "arena", name: "Arena" }] });

    expect(screen.getByTestId("homepage-start-template-arena")).toBeTruthy();
    expect(
      screen
        .getByTestId("homepage-start-template-arena")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
  });

  it("opens Create Project with Empty selected from the Start strip", async () => {
    renderHomepage();
    screen.getByTestId("homepage-start-empty").click();

    expect(await screen.findByTestId("create-project-dialog")).toBeTruthy();
    expect(
      screen.getByTestId("create-project-empty").getAttribute("data-selected"),
    ).toBe("true");
  });

  it("opens Create Project with 2D selected from the Start strip", async () => {
    renderHomepage();
    screen.getByTestId("homepage-start-2d").click();

    expect(await screen.findByTestId("create-project-dialog")).toBeTruthy();
    expect(
      screen.getByTestId("create-project-2d").getAttribute("data-selected"),
    ).toBe("true");
  });

  it("opens Create Project with a discovered template selected from the Start strip", async () => {
    renderHomepage({ templates: [{ id: "arena", name: "Arena" }] });
    screen.getByTestId("homepage-start-template-arena").click();

    expect(await screen.findByTestId("create-project-dialog")).toBeTruthy();
    expect(
      screen
        .getByTestId("create-project-template-arena")
        .getAttribute("data-selected"),
    ).toBe("true");
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
  it("renders recent projects as card rows with image wells", () => {
    renderHomepage({
      projects: [listedProject("Game.babproject", "opfs")],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.querySelector('[data-testid="project-card-well"]')).toBeTruthy();
  });

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

  it("gives dialog template cards an image well", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const empty = await screen.findByTestId("create-project-empty");
    expect(empty.querySelector('[data-testid="template-card-well"]')).toBeTruthy();
    expect(
      screen
        .getByTestId("create-project-2d")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
  });

  it("uses App Documents and Choose Folder toggles on native", async () => {
    getHostPlatform.mockReturnValue("ios");
    renderHomepage();
    screen.getByTestId("create-project").click();

    expect(await screen.findByTestId("create-project-app-documents")).toBeTruthy();
    expect(screen.getByTestId("create-project-choose-folder")).toBeTruthy();
    expect(screen.getByTestId("create-project-location").textContent).toMatch(
      /App Documents/,
    );

    const choose = screen.getByTestId("create-project-choose-folder");
    fireEvent.click(choose);
    expect(screen.getByTestId("create-project-location").textContent).toMatch(
      /Choose a folder/,
    );
  });
});
