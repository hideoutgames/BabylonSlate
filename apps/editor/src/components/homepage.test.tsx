import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ProjectFolderHandle } from "@haptic/core";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import { signedInHosts } from "../testing/source-control-hosts";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { BUILT_IN_STARTER_KINDS } from "../lib/create-project";
import type { ListedProject } from "../lib/listed-projects";
import { Homepage } from "./homepage";
import { HomepageMobileAccountGate } from "./homepage-mobile-account-gate";
import { AppSettingsProvider, getAppSettingsSnapshot } from "../context/app-settings-context";
import { EditorThemeProvider } from "../context/theme-context";

const { getHostPlatform, pickImportFiles } = vi.hoisted(() => ({
  getHostPlatform: vi.fn(() => "web"),
  pickImportFiles: vi.fn(async () => []),
}));

vi.mock("@haptic/vfs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/vfs")>();
  return { ...actual, getHostPlatform, pickImportFiles };
});

vi.mock("./settings-modal", () => ({
  SettingsModal: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div role="dialog" aria-label="Engine Settings">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close Engine Settings
        </button>
      </div>
    ) : null,
}));

// The mobile account gate's native auth adapter (FAPI and secure storage have their own tests).
const nativeAuth = vi.hoisted(() => ({ restore: vi.fn(), cancelSignIn: vi.fn() }));
vi.mock("../services/native-clerk", () => ({
  createNativeClerkClient: () => nativeAuth,
}));
const nativeSession = {
  id: "session_ada",
  userId: "user_ada",
  email: "ada@example.test",
  name: "Ada Lovelace",
};

const accountsState = vi.hoisted(() => ({ accounts: null as SourceControlAccounts | null }));

// New Project's Remote reads the device's accounts: signed in to test mode's fake GitHub.
vi.mock("../services/source-control-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/source-control-accounts")>();
  return { ...actual, sourceControlAccounts: async () => accountsState.accounts! };
});

beforeEach(async () => {
  accountsState.accounts = await signedInHosts(new FakeGitHost().http);
  localStorage.clear();
  vi.stubGlobal("__HAPTIC_BUILD_LABEL__", "0.0.1 Development build");
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  cleanup();
  getHostPlatform.mockReturnValue("web");
  pickImportFiles.mockReset();
  nativeAuth.restore.mockReset();
});

const noop = async () => {};

function renderHomepage(
  overrides: Partial<ComponentProps<typeof Homepage>> = {},
  { mobileAccountGate = false } = {},
) {
  const homepage = (
    <Homepage
      projects={[]}
      templates={[]}
      needsReconnect={false}
      recoveryAvailable={false}
      onCreateEmpty={noop}
      onCreateFromTemplate={noop}
      onOpenExternal={noop}
      onOpenProject={noop}
      onUpdateProject={noop}
      onRemoveFromList={noop}
      onReconnect={noop}
      onRecover={noop}
      onDismissRecovery={() => {}}
      onSettingsChanged={noop}
      {...overrides}
    />
  );
  return render(
    <TooltipProvider>
      <AppSettingsProvider>
        <EditorThemeProvider>
          {mobileAccountGate ? (
            <HomepageMobileAccountGate>{homepage}</HomepageMobileAccountGate>
          ) : (
            homepage
          )}
        </EditorThemeProvider>
      </AppSettingsProvider>
    </TooltipProvider>,
  );
}

function listedProject(
  name: string,
  tier: ListedProject["tier"],
): ListedProject {
  return { id: `${tier}:${name}`, name, tier, label: name };
}

/** Profile → Manage Account → the Account dialog's Application section. */
async function openApplicationSettings() {
  fireEvent.click(screen.getByTestId("homepage-account"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Account/ }));
  const dialog = await screen.findByRole("dialog", { name: "Account" });
  fireEvent.click(
    within(within(dialog).getByRole("navigation", { name: "Categories" })).getByRole(
      "button",
      { name: "Application" },
    ),
  );
  return within(dialog).findByRole("switch", { name: "Automatic Updates" });
}

function createDialog(id = "blank") {
  fireEvent.click(screen.getByTestId("create-project"));
  fireEvent.click(screen.getByTestId(`create-project-${id}`));
}

describe("Haptic project browser", () => {
  it("marks every project Local and only source-controlled projects Source Control", () => {
    renderHomepage({
      projects: [
        { ...listedProject("Tracked", "opfs"), sourceControl: true },
        listedProject("Untracked", "opfs"),
      ],
    });
    const tracked = screen.getByTestId("open-listed-project-Tracked");
    const untracked = screen.getByTestId("open-listed-project-Untracked");
    expect(within(tracked).getByTestId("homepage-project-local").textContent).toBe("Local");
    expect(within(untracked).getByTestId("homepage-project-local").textContent).toBe("Local");
    expect(
      within(tracked).getByTestId("homepage-project-source-control").textContent,
    ).toBe("Source Control");
    expect(within(untracked).queryByTestId("homepage-project-source-control")).toBeNull();
  });

  it("links the sidebar's Discord badge to the server outside the app window", () => {
    renderHomepage();
    const badge = screen.getByRole("link", { name: "Join our Discord" });
    expect(badge.getAttribute("href")).toBe("https://discord.gg/7uPR4JK5q3");
    expect(badge.getAttribute("target")).toBe("_blank");
  });

  it("opens web folder or ZIP imports explicitly", async () => {
    const onOpenExternal = vi.fn(async () => {});
    renderHomepage({ onOpenExternal });
    fireEvent.click(screen.getByTestId("open-project"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import Folder" }));
    await waitFor(() =>
      expect(onOpenExternal).toHaveBeenLastCalledWith("folder"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("open-project")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByTestId("open-project"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import ZIP" }));
    await waitFor(() => expect(onOpenExternal).toHaveBeenLastCalledWith("zip"));
    expect(onOpenExternal).toHaveBeenCalledTimes(2);
  });

  it("locks actions while opening and exposes a recoverable failure", async () => {
    let rejectOpen!: (error: Error) => void;
    const onOpenProject = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectOpen = reject;
        }),
    );
    renderHomepage({
      projects: [listedProject("Game", "opfs")],
      onOpenProject,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Project Game" }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toBe("Opening Project…");
    expect(screen.getByTestId("create-project")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("homepage-account")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByTestId("homepage-start-blank"));
    expect(screen.queryByTestId("create-project-dialog")).toBeNull();
    await act(async () => rejectOpen(new Error("Project unavailable")));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("homepage-error").textContent).toContain(
      "Project unavailable",
    );
    expect(screen.getByTestId("create-project")).toHaveProperty(
      "disabled",
      false,
    );
    createDialog();
    expect(screen.getByTestId("create-project-dialog")).toBeTruthy();
  });

  it("shows the creation's real percent from 0, never lower, and keeps the announced text still", async () => {
    let report!: (percent: number) => void;
    let finish!: () => void;
    const onCreateEmpty = vi.fn<ComponentProps<typeof Homepage>["onCreateEmpty"]>(
      (_name, options) =>
        new Promise<void>((resolve) => {
          report = options!.onProgress!;
          finish = resolve;
        }),
    );
    renderHomepage({ onCreateEmpty });
    createDialog();
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "Orbit" } });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() => expect(onCreateEmpty).toHaveBeenCalledOnce());
    // The dialog stays open while it creates, so the header status sits behind it.
    const status = () => screen.getByRole("status", { hidden: true });
    expect(status().textContent).toBe("Creating Project… 0%");
    act(() => report(0));
    act(() => report(37));
    expect(status().textContent).toBe("Creating Project… 37%");
    act(() => report(12));
    expect(status().textContent).toBe("Creating Project… 37%");
    act(() => report(100));
    expect(status().textContent).toBe("Creating Project… 100%");
    // The percent sits outside what a screen reader announces.
    expect(status().querySelector("[aria-hidden]:not(svg)")?.textContent).toBe(" 100%");
    await act(async () => finish());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("locks template import without adding a status row and restores actions after failure", async () => {
    let rejectImport!: (error: Error) => void;
    pickImportFiles.mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectImport = reject;
        }),
    );
    renderHomepage();
    fireEvent.click(screen.getByRole("button", { name: /^Templates/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add Template" }));
    expect(screen.getByRole("button", { name: "Add Template" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByTestId("homepage-start-blank").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByText(/Importing Template/i)).toBeNull();
    fireEvent.click(screen.getByTestId("homepage-start-blank"));
    expect(screen.queryByTestId("create-project-dialog")).toBeNull();
    await act(async () => rejectImport(new Error("Template unavailable")));
    expect(screen.getByTestId("homepage-error").textContent).toContain(
      "Template unavailable",
    );
    expect(screen.getByRole("button", { name: "Add Template" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it.each([...BUILT_IN_STARTER_KINDS])(
    "creates a named %s project with the selected appearance",
    async (kind) => {
      // Feature Test is listed only in the Debug Mode Engine Setting.
      if (kind === "feature-test") localStorage.setItem("haptic:engine-settings", JSON.stringify({ debugMode: true }));
      const onCreateEmpty = vi.fn(async () => {});
      renderHomepage({ onCreateEmpty });
      fireEvent.click(screen.getByTestId("create-project"));
      fireEvent.click(await screen.findByTestId(`create-project-${kind}`));
      fireEvent.change(screen.getByTestId("create-project-name"), {
        target: { value: "Orbit" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Violet" }));
      fireEvent.click(screen.getByTestId("create-project-submit"));
      await waitFor(() =>
        expect(onCreateEmpty).toHaveBeenCalledWith(
          "Orbit",
          expect.objectContaining({
            kind,
            appearance: expect.objectContaining({ color: "violet" }),
          }),
        ),
      );
    },
  );

  it("hides Hosting without source control, and starts each New Project from this device's last Hosting choice", async () => {
    const onCreateEmpty = vi.fn<ComponentProps<typeof Homepage>["onCreateEmpty"]>(async () => {});
    // Production web has no source control: every project is Local.
    const web = renderHomepage({ onCreateEmpty });
    createDialog();
    expect(screen.queryByTestId("create-project-hosting-remote")).toBeNull();
    web.unmount();

    getHostPlatform.mockReturnValue("electron");
    renderHomepage({ onCreateEmpty });
    createDialog();
    expect(screen.getByTestId("create-project-hosting-local").getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "Forest Run" } });
    fireEvent.click(screen.getByTestId("create-project-hosting-remote"));
    await waitFor(() => expect(screen.getByTestId("create-project-submit").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() => expect(onCreateEmpty).toHaveBeenCalledTimes(1));
    const options = onCreateEmpty.mock.calls[0]![1]!;
    expect(options.repository).toEqual({
      origin: "https://github.com",
      owner: { name: "test-user", kind: "user", id: "" },
      name: "forest-run",
      private: true,
    });
    // The provider reports Opening project and Initializing source control through it.
    expect(options.onPhase).toEqual(expect.any(Function));
    await waitFor(() => expect(screen.queryByTestId("create-project-dialog")).toBeNull());
    await waitFor(() => expect(getAppSettingsSnapshot().settings.newProjectHosting).toEqual({ hosting: "remote", origin: "https://github.com" }));

    // The next New Project starts at Remote on the same account; a Local create publishes nothing.
    createDialog();
    expect(screen.getByTestId("create-project-hosting-remote").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("create-project-hosting-local"));
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() => expect(onCreateEmpty).toHaveBeenCalledTimes(2));
    expect(onCreateEmpty.mock.calls[1]![1]!.repository).toBeUndefined();
    await waitFor(() => expect(screen.queryByTestId("create-project-dialog")).toBeNull());
    createDialog();
    expect(screen.getByTestId("create-project-hosting-local").getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    ["Include", true],
    ["Create Without", false],
  ] as const)("asks once about Engine Plugins with Execute JavaScript while creating, and %s answers %s", async (button, include) => {
    const answers: boolean[] = [];
    const onCreateEmpty = vi.fn<ComponentProps<typeof Homepage>["onCreateEmpty"]>(async (_name, options) => {
      answers.push(await options!.reviewExecuteJavaScript!([
        { pluginGuid: "a", displayName: "Combat Pack", assets: [
          { guid: "hero", name: "Hero", type: "Class", path: "combat-pack/assets/Hero.class.hasset", nodes: [{ nodeId: "js", body: "1" }] },
        ] },
        { pluginGuid: "b", displayName: "Net Pack", assets: [
          { guid: "net", name: "Net", type: "Class", nodes: [{ nodeId: "a", body: "1" }, { nodeId: "b", body: "2" }] },
        ] },
      ]));
    });
    renderHomepage({ onCreateEmpty });
    createDialog();
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "Orbit" } });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    const dialog = await screen.findByTestId("execute-javascript-import-dialog");
    expect(dialog.textContent).toContain("Include Execute JavaScript?");
    // A starter is created from scratch, so it starts trusted and Include makes this code playable at once.
    expect(dialog.textContent).toContain("The new project is trusted on this computer, so this code runs when you press Play.");
    expect([...screen.getByTestId("execute-javascript-import-list").querySelectorAll("li")].map((row) => row.textContent))
      .toEqual(["Hero (Class) in Combat Pack1 node", "Net (Class) in Net Pack2 nodes"]);
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(answers).toEqual([include]));
    await waitFor(() => expect(screen.queryByTestId("execute-javascript-import-dialog")).toBeNull());
    expect(onCreateEmpty).toHaveBeenCalledTimes(1);
  });

  it("starts naming a project straight from a welcome tile in an empty library", async () => {
    const onCreateEmpty = vi.fn(async () => {});
    renderHomepage({ onCreateEmpty });
    fireEvent.click(screen.getByTestId("homepage-empty-start-2d"));
    expect(screen.queryByTestId("create-project-2d")).toBeNull();
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Tiles" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(onCreateEmpty).toHaveBeenCalledWith(
        "Tiles",
        expect.objectContaining({ kind: "2d" }),
      ),
    );
  });

  it("searches custom templates and creates from the selected one", async () => {
    const onCreateFromTemplate = vi.fn(async () => {});
    renderHomepage({
      templates: [{ id: "arena", name: "Arena" }],
      onCreateFromTemplate,
    });
    fireEvent.click(screen.getByTestId("create-project"));
    fireEvent.change(
      screen.getAllByTestId("homepage-template-search").at(-1)!,
      { target: { value: "Arena" } },
    );
    fireEvent.click(screen.getByTestId("create-project-template:arena"));
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "My Arena" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(onCreateFromTemplate).toHaveBeenCalledWith(
        "arena",
        "My Arena",
        expect.any(Object),
      ),
    );
  });

  it("says a template project's included Execute JavaScript waits for trust", async () => {
    const onCreateFromTemplate = vi.fn<ComponentProps<typeof Homepage>["onCreateFromTemplate"]>(async (_id, _name, options) => {
      await options!.reviewExecuteJavaScript!([{ pluginGuid: "a", displayName: "Combat Pack", assets: [
        { guid: "hero", name: "Hero", type: "Class", nodes: [{ nodeId: "js", body: "1" }] },
      ] }]);
    });
    renderHomepage({ templates: [{ id: "arena", name: "Arena" }], onCreateFromTemplate });
    fireEvent.click(screen.getByTestId("create-project"));
    fireEvent.click(screen.getByTestId("create-project-template:arena"));
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "My Arena" } });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    const dialog = await screen.findByTestId("execute-javascript-import-dialog");
    expect(dialog.textContent).toContain("A project made from a template is not trusted, so this code runs only once you trust the project.");
    expect(dialog.textContent).not.toContain("The new project is trusted");
    fireEvent.click(screen.getByRole("button", { name: "Create Without" }));
    await waitFor(() => expect(onCreateFromTemplate).toHaveBeenCalledTimes(1));
  });

  it("creates the suggested name when the field is left empty", async () => {
    const onCreateEmpty = vi.fn(async () => {});
    renderHomepage({ projects: [listedProject("Orbit", "opfs")], onCreateEmpty });
    createDialog();
    const name = screen.getByTestId("create-project-name") as HTMLInputElement;
    expect(name.value).toBe("");
    expect(name.placeholder).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(screen.queryByTestId("create-project-name-issue")).toBeNull();
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(onCreateEmpty).toHaveBeenCalledWith(
        name.placeholder,
        expect.any(Object),
      ),
    );
  });

  it("flags a duplicate name while typing and clears it for a free name", () => {
    renderHomepage({ projects: [listedProject("Orbit", "opfs")] });
    createDialog();
    const name = screen.getByTestId("create-project-name");
    fireEvent.change(name, { target: { value: "orbit" } });
    expect(screen.getByTestId("create-project-name-issue").textContent).toMatch(
      /already exists/i,
    );
    expect(screen.getByTestId("create-project-submit")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(name, { target: { value: "Orbit 2" } });
    expect(screen.queryByTestId("create-project-name-issue")).toBeNull();
    expect(screen.getByTestId("create-project-submit")).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("retains the draft when creation fails", async () => {
    renderHomepage({
      onCreateEmpty: vi.fn(async () => {
        throw new Error("Storage full");
      }),
    });
    createDialog();
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Orbit" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Storage full"),
    );
    expect(screen.getByTestId("create-project-name")).toHaveProperty(
      "value",
      "Orbit",
    );
  });

  // The iOS and Android apps check the account again whenever the window regains focus (iOS also sends focus while
  // the app stays in front). The check runs in the background, but a definitive sign-out would still drop what is
  // being filled in, so it waits while a form is open and runs once the last one closes.
  it("keeps New Project, Clone and Engine Settings open through the mobile account's session check, and checks once they close", async () => {
    getHostPlatform.mockReturnValue("ios");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubGlobal("PointerEvent", MouseEvent);
    nativeAuth.restore.mockResolvedValue({ status: "signed-in", session: nativeSession });
    renderHomepage({ onCloneProject: vi.fn() }, { mobileAccountGate: true });

    fireEvent.click(await screen.findByTestId("create-project"));
    fireEvent.click(screen.getByTestId("create-project-blank"));
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "Orbit" } });
    fireEvent.click(screen.getByText("Options"));
    fireEvent(window, new Event("focus"));
    const create = screen.getByTestId("create-project-dialog");
    expect(screen.getByTestId("create-project-name")).toHaveProperty("value", "Orbit");
    expect(within(create).getByText("Options").closest("details")?.open).toBe(true);
    expect(nativeAuth.restore).toHaveBeenCalledTimes(1);
    fireEvent.click(within(create).getByRole("button", { name: "Cancel" }));
    // The check that waited runs as soon as New Project closes.
    await waitFor(() => expect(nativeAuth.restore).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("create-project")).toBeTruthy();

    fireEvent.click(screen.getByTestId("clone-project"));
    const clone = await screen.findByTestId("clone-project-dialog");
    fireEvent(window, new Event("focus"));
    expect(screen.getByTestId("clone-project-dialog")).toBe(clone);
    expect(nativeAuth.restore).toHaveBeenCalledTimes(2);
    fireEvent.click(within(clone).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(nativeAuth.restore).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId("clone-project")).toBeTruthy();

    fireEvent.click(
      await screen.findByRole("button", { name: `${nativeSession.name}, ${nativeSession.email}`, expanded: false }),
    );
    fireEvent.click(await screen.findByTestId("engine-settings"));
    const settings = await screen.findByRole("dialog", { name: "Engine Settings" });
    fireEvent(window, new Event("focus"));
    expect(screen.getByRole("dialog", { name: "Engine Settings" })).toBe(settings);
    expect(nativeAuth.restore).toHaveBeenCalledTimes(3);
    fireEvent.click(within(settings).getByRole("button", { name: "Close Engine Settings" }));
    await waitFor(() => expect(nativeAuth.restore).toHaveBeenCalledTimes(4));

    // Closing a form with no focus while it was open runs no check; with every form closed, focus checks at once
    // without covering the Homepage.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Engine Settings" })).toBeNull());
    expect(await screen.findByTestId("create-project")).toBeTruthy();
    fireEvent.click(screen.getByTestId("clone-project"));
    const quiet = await screen.findByTestId("clone-project-dialog");
    fireEvent.click(within(quiet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("clone-project-dialog")).toBeNull());
    expect(nativeAuth.restore).toHaveBeenCalledTimes(4);
    fireEvent(window, new Event("focus"));
    expect(nativeAuth.restore).toHaveBeenCalledTimes(5);
    expect(nativeAuth.restore).toHaveBeenLastCalledWith({ background: true });
    expect(screen.getByTestId("create-project")).toBeTruthy();
  });

  it("keeps a check that finds no session waiting until the open form closes, then returns to sign-in", async () => {
    getHostPlatform.mockReturnValue("ios");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubGlobal("PointerEvent", MouseEvent);
    nativeAuth.restore
      .mockResolvedValueOnce({ status: "signed-in", session: nativeSession })
      .mockResolvedValueOnce({ status: "signed-out" });
    renderHomepage({ onCloneProject: vi.fn() }, { mobileAccountGate: true });
    fireEvent.click(await screen.findByTestId("clone-project"));
    const clone = await screen.findByTestId("clone-project-dialog");
    fireEvent(window, new Event("focus"));
    expect(screen.getByTestId("clone-project-dialog")).toBe(clone);
    fireEvent.click(within(clone).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(screen.queryByTestId("create-project")).toBeNull();
  });

  it.each(["ios", "electron"])(
    "offers native folder choice on %s",
    async (platform) => {
      getHostPlatform.mockReturnValue(platform);
      const onCreateEmpty = vi.fn(async () => {});
      renderHomepage({ onCreateEmpty });
      createDialog();
      fireEvent.change(screen.getByTestId("create-project-name"), {
        target: { value: "Orbit" },
      });
      fireEvent.click(screen.getByText("Options"));
      fireEvent.click(screen.getByTestId("create-project-choose-location"));
      fireEvent.click(screen.getByTestId("create-project-submit"));
      await waitFor(() =>
        expect(onCreateEmpty).toHaveBeenCalledWith(
          "Orbit",
          expect.objectContaining({ pickFolder: true }),
        ),
      );
    },
  );

  it.each(["button", "keyboard", "context"])(
    "opens project actions using %s without launching",
    (method) => {
      const onOpenProject = vi.fn(async () => {});
      renderHomepage({
        projects: [listedProject("Game", "opfs")],
        onOpenProject,
      });
      const card = screen.getByTestId("open-listed-project-Game");
      if (method === "button")
        fireEvent.click(
          screen.getByRole("button", { name: "Project Actions for Game" }),
        );
      else if (method === "keyboard")
        fireEvent.keyDown(card, { key: "F10", shiftKey: true });
      else fireEvent.contextMenu(card, { clientX: 30, clientY: 30 });
      expect(screen.getByTestId("homepage-project-menu")).toBeTruthy();
      expect(onOpenProject).not.toHaveBeenCalled();
    },
  );

  it("edits identity without creating or opening a project", async () => {
    let finishUpdate!: () => void;
    const onUpdateProject = vi.fn(() => new Promise<void>((resolve) => { finishUpdate = resolve; }));
    const onOpenProject = vi.fn(async () => {});
    renderHomepage({
      projects: [listedProject("Game", "opfs")],
      onUpdateProject,
      onOpenProject,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Project Actions for Game" }),
    );
    fireEvent.click(screen.getByTestId("homepage-project-rename"));
    expect(screen.queryByTestId("create-project-templates")).toBeNull();
    fireEvent.change(screen.getByTestId("homepage-rename-input"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByTestId("homepage-rename-confirm"));
    await waitFor(() =>
      expect(onUpdateProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Game" }),
        expect.objectContaining({ name: "Renamed" }),
      ),
    );
    // An update has no percent.
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Updating Project…");
    await act(async () => finishUpdate());
    expect(screen.queryByRole("status")).toBeNull();
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it.each([
    ["web", "opfs", "Delete", "Delete Game?", "destructive", "Delete"],
    ["ios", "documents", "Delete", "Delete Game?", "destructive", "Delete"],
    ["android", "documents", "Delete", "Delete Game?", "destructive", "Delete"],
    ["electron", "documents", "Delete", "Delete Game?", "destructive", "Delete"],
    ["ios", "external", "Remove From List", "Remove Game?", "warning", "Remove From List"],
    ["electron", "external", "Remove From List", "Remove Game?", "warning", "Remove From List"],
  ] as const)(
    "confirms %s %s project removal before changing storage",
    async (platform, tier, item, title, variant, action) => {
      getHostPlatform.mockReturnValue(platform);
      const onRemoveFromList = vi.fn(async () => {});
      renderHomepage({
        projects: [listedProject("Game", tier)],
        onRemoveFromList,
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Project Actions for Game" }),
      );
      expect(screen.getByTestId("homepage-project-remove").textContent).toBe(item);
      fireEvent.click(screen.getByTestId("homepage-project-remove"));
      const dialog = screen.getByTestId("homepage-remove-dialog");
      expect(within(dialog).getByRole("heading", { name: title })).toBeTruthy();
      expect(dialog.getAttribute("data-variant")).toBe(variant);
      // Removing explains how it differs from deleting; deleting needs no comparison.
      expect(!!within(dialog).queryByTestId("homepage-remove-compare")).toBe(
        tier === "external",
      );
      expect(screen.getByTestId("homepage-remove-confirm").textContent).toBe(
        action,
      );
      expect(onRemoveFromList).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("homepage-remove-confirm"));
      await waitFor(() => expect(onRemoveFromList).toHaveBeenCalledOnce());
    },
  );

  it("selects projects from the actions menu instead of opening them, and Cancel ends selection", () => {
    const onOpenProject = vi.fn(async () => {});
    renderHomepage({
      projects: [listedProject("Orbit", "opfs"), listedProject("Tide", "opfs")],
      onOpenProject,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Project Actions for Orbit" }),
    );
    fireEvent.click(screen.getByTestId("homepage-project-select"));

    const orbit = screen.getByRole("button", { name: "Select Orbit" });
    const tide = screen.getByRole("button", { name: "Select Tide" });
    expect(orbit.getAttribute("aria-pressed")).toBe("true");
    expect(tide.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Project Actions for/ })).toBeNull();
    fireEvent.click(tide);
    fireEvent.click(orbit);
    expect(orbit.getAttribute("aria-pressed")).toBe("false");
    expect(tide.getAttribute("aria-pressed")).toBe("true");
    expect(onOpenProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Selection" }));
    expect(screen.queryByRole("button", { name: "Select Tide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select Projects" }));
    expect(
      screen.getByRole("button", { name: "Select Tide" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("Select All selects only the projects the search shows", () => {
    renderHomepage({
      projects: [
        listedProject("Orbit", "opfs"),
        listedProject("Orbit Two", "opfs"),
        listedProject("Tide", "opfs"),
      ],
    });
    fireEvent.change(screen.getByTestId("homepage-project-search"), {
      target: { value: "Orbit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Select Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Select All" }));
    fireEvent.change(screen.getByTestId("homepage-project-search"), {
      target: { value: "" },
    });
    expect(
      ["Orbit", "Orbit Two", "Tide"].map((name) =>
        screen
          .getByRole("button", { name: `Select ${name}` })
          .getAttribute("aria-pressed"),
      ),
    ).toEqual(["true", "true", "false"]);
  });

  it("deletes only the selected projects it can delete, after the confirmation phrase", async () => {
    const onRemoveFromList = vi.fn<(handle: ProjectFolderHandle) => Promise<void>>(
      async () => {},
    );
    renderHomepage({
      projects: [
        listedProject("Orbit", "opfs"),
        listedProject("Picked", "external"),
        listedProject("Tide", "documents"),
        listedProject("Unselected", "opfs"),
      ],
      onRemoveFromList,
    });
    fireEvent.click(screen.getByRole("button", { name: "Select Projects" }));
    for (const name of ["Orbit", "Picked", "Tide"])
      fireEvent.click(screen.getByRole("button", { name: `Select ${name}` }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Selected Projects" }),
    );

    const dialog = screen.getByTestId("homepage-delete-projects-dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Delete 2 Projects?" }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("homepage-delete-projects-list"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Orbit", "Tide"]);
    expect(
      within(screen.getByTestId("homepage-delete-projects-kept"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Picked"]);

    const confirm = screen.getByTestId("homepage-delete-projects-confirm");
    const phrase = screen.getByTestId("homepage-delete-projects-input");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(phrase, { target: { value: "delete my project" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(onRemoveFromList).not.toHaveBeenCalled();
    fireEvent.change(phrase, { target: { value: " Delete my projects " } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(onRemoveFromList).toHaveBeenCalledTimes(2));
    expect(onRemoveFromList.mock.calls.map(([project]) => project.id)).toEqual([
      "opfs:Orbit",
      "documents:Tide",
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select Projects" })).toBeTruthy(),
    );
  });

  it("lists chosen-folder projects as kept and offers no Delete when none can be deleted", () => {
    renderHomepage({ projects: [listedProject("Picked", "external")] });
    fireEvent.click(screen.getByRole("button", { name: "Select Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Picked" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Selected Projects" }),
    );
    expect(screen.getByTestId("homepage-delete-projects-kept").textContent).toBe(
      "Picked",
    );
    expect(screen.queryByTestId("homepage-delete-projects-input")).toBeNull();
    expect(screen.queryByTestId("homepage-delete-projects-confirm")).toBeNull();
  });

  it("stops at a failed delete, shows the error and keeps selecting", async () => {
    const onRemoveFromList = vi.fn(async (handle: ProjectFolderHandle) => {
      if (handle.name === "Orbit") throw new Error("Orbit is busy");
    });
    renderHomepage({
      projects: [listedProject("Orbit", "opfs"), listedProject("Tide", "opfs")],
      onRemoveFromList,
    });
    fireEvent.click(screen.getByRole("button", { name: "Select Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Select All" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Selected Projects" }),
    );
    fireEvent.change(screen.getByTestId("homepage-delete-projects-input"), {
      target: { value: "delete my projects" },
    });
    fireEvent.click(screen.getByTestId("homepage-delete-projects-confirm"));

    expect((await screen.findByTestId("homepage-error")).textContent).toContain(
      "Orbit is busy",
    );
    expect(onRemoveFromList).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Select Tide" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("searches projects without changing the stored library", () => {
    renderHomepage({
      projects: [listedProject("Orbit", "opfs"), listedProject("Tide", "opfs")],
    });
    fireEvent.change(screen.getByTestId("homepage-project-search"), {
      target: { value: "Tide" },
    });
    expect(screen.queryByTestId("open-listed-project-Orbit")).toBeNull();
    expect(screen.getByTestId("open-listed-project-Tide")).toBeTruthy();
  });

  it("persists the Account dialog's update toggle in shared Engine Settings", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubGlobal("PointerEvent", MouseEvent);
    getHostPlatform.mockReturnValue("electron");
    const { unmount } = renderHomepage();
    let autoUpdate = await openApplicationSettings();
    await waitFor(() => expect(autoUpdate.getAttribute("aria-disabled")).not.toBe("true"));
    expect(autoUpdate.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(autoUpdate);
    await waitFor(() => expect(autoUpdate.getAttribute("aria-checked")).toBe("false"));
    expect(JSON.parse(localStorage.getItem("haptic:engine-settings")!).automaticUpdatesEnabled).toBe(false);
    unmount();

    renderHomepage();
    autoUpdate = await openApplicationSettings();
    await waitFor(() => expect(autoUpdate.getAttribute("aria-checked")).toBe("false"));
    vi.unstubAllEnvs();
  });

  it.each(["web", "ios"])("does not offer desktop update control on %s", async host => {
    getHostPlatform.mockReturnValue(host);
    renderHomepage();
    expect((await openApplicationSettings()).getAttribute("aria-disabled")).toBe("true");
  });
});
