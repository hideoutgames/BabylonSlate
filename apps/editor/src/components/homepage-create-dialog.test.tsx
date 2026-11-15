import { useCallback, useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import type { HostPlatform, NewProjectHosting } from "@haptic/vfs";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { ContextMenuOverlay } from "@haptic/editor-kit";
import * as appearanceHelpers from "./homepage-project-appearance";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import type { NewRepositoryRequest } from "../services/source-control-publish";
import { signedInHosts } from "../testing/source-control-hosts";

const accountsState = vi.hoisted(() => ({ accounts: null as SourceControlAccounts | null }));

// The device's accounts over in-memory secrets; the host is test mode's fake GitHub and GitLab.
vi.mock("../services/source-control-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/source-control-accounts")>();
  return { ...actual, sourceControlAccounts: async () => accountsState.accounts! };
});

let host: FakeGitHost;

beforeEach(async () => {
  host = new FakeGitHost();
  accountsState.accounts = await signedInHosts(host.http);
});

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ignoreRepository = () => {};

function Composer({
  mode = "create",
  onSubmit = vi.fn(),
  open = true,
  busy = false,
  onOpenChange = vi.fn(),
  hostPlatform = "web",
  initialHosting = null,
  onRepositoryChange = ignoreRepository,
}: {
  mode?: "create" | "edit";
  onSubmit?: () => void;
  open?: boolean;
  busy?: boolean;
  onOpenChange?: (open: boolean) => void;
  hostPlatform?: HostPlatform;
  /** Null: no source control here, so no Hosting choice. */
  initialHosting?: NewProjectHosting | null;
  onRepositoryChange?: (request: NewRepositoryRequest | null) => void;
}) {
  const [name, setName] = useState(mode === "edit" ? "Moon Garden" : "");
  const [hosting, setHosting] = useState(initialHosting);
  const [pickFolder, setPickFolder] = useState(false);
  const [repository, setRepository] = useState<NewRepositoryRequest | null>(null);
  // Stable, as the Homepage's state setter is: the fields report each change through it.
  const reportRepository = useCallback((request: NewRepositoryRequest | null) => {
    setRepository(request);
    onRepositoryChange(request);
  }, [onRepositoryChange]);
  const [appearance, setAppearance] = useState({ icon: "box", color: "coral" });
  const [templateId, setTemplateId] = useState("empty");
  const [size, setSize] = useState({ width: 1920, height: 1080 });
  const [pixelArt, setPixelArt] = useState(false);
  const props = {
    mode,
    open,
    onOpenChange,
    busy,
    name,
    onNameChange: setName,
    nameIssue: name.trim() ? null : "Name required.",
    appearance,
    onAppearanceChange: setAppearance,
    templateId,
    onTemplateIdChange: setTemplateId,
    templates: [{ id: "island", name: "Island" }],
    hostPlatform,
    pickFolder,
    onPickFolderChange: setPickFolder,
    hosting,
    onHostingChange: (next: NewProjectHosting) => {
      setHosting(next);
      if (next === "remote" && (hostPlatform === "ios" || hostPlatform === "android")) setPickFolder(false);
    },
    rememberedOrigin: "",
    remoteReady: repository !== null,
    onRepositoryChange: reportRepository,
    width: size.width,
    height: size.height,
    onWidthChange: (width: number) => setSize((current) => ({ ...current, width })),
    onHeightChange: (height: number) => setSize((current) => ({ ...current, height })),
    blackBars: false,
    onBlackBarsChange: vi.fn(),
    pixelArt,
    onPixelArtChange: (enabled: boolean) => {
      setPixelArt(enabled);
      setSize(enabled ? { width: 640, height: 360 } : { width: 1920, height: 1080 });
    },
    onSubmit,
  } satisfies ComponentProps<typeof HomepageCreateDialog>;
  return <HomepageCreateDialog {...props} />;
}

describe("Project Composer", () => {
  it("creates Local or Remote, with a new repository on the signed-in account whose name follows the project's until edited", async () => {
    const onSubmit = vi.fn();
    const onRepositoryChange = vi.fn();
    render(<Composer initialHosting="local" onSubmit={onSubmit} onRepositoryChange={onRepositoryChange} />);
    expect(screen.getByTestId("create-project-hosting-local").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("create-project-remote")).toBeNull();
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "Forest Run" } });
    fireEvent.click(screen.getByTestId("create-project-hosting-remote"));
    expect((await screen.findByTestId("create-project-remote-host")).textContent).toContain("GitHub · ada");
    await waitFor(() => expect(screen.getByTestId("create-project-remote-owner").textContent).toContain("test-user"));
    const repositoryName = screen.getByTestId("create-project-remote-name") as HTMLInputElement;
    expect(repositoryName.value).toBe("forest-run");
    await waitFor(() => expect(onRepositoryChange).toHaveBeenLastCalledWith({
      origin: "https://github.com",
      owner: { name: "test-user", kind: "user", id: "" },
      name: "forest-run",
      private: true,
    }));
    fireEvent.click(screen.getByTestId("create-project-remote-public"));
    fireEvent.change(repositoryName, { target: { value: "forest" } });
    // Once edited, the repository keeps its name when the project's changes.
    fireEvent.change(screen.getByTestId("create-project-name"), { target: { value: "Forest Run Two" } });
    expect(repositoryName.value).toBe("forest");
    await waitFor(() => expect(onRepositoryChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: "forest", private: false })));
    fireEvent.change(repositoryName, { target: { value: " " } });
    await waitFor(() => expect(screen.getByTestId("create-project-remote-reason").textContent).toBe("Enter a repository name."));
    expect(onRepositoryChange).toHaveBeenLastCalledWith(null);
    // Enter in the form does not create a Remote project that has no repository.
    fireEvent.submit(screen.getByTestId("create-project-form"));
    expect(screen.getByTestId("create-project-submit").hasAttribute("disabled")).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers Sign In To GitHub and GitLab, through the link warning, when no account can create a repository", async () => {
    accountsState.accounts = await signedInHosts(host.http, null);
    // A build with both hosts' sign-in apps.
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "github-client");
    vi.stubEnv("VITE_GITLAB_CLIENT_ID", "gitlab-client");
    const onSubmit = vi.fn();
    render(<Composer initialHosting="remote" onSubmit={onSubmit} />);
    expect((await screen.findByTestId("create-project-remote-reason")).textContent).toBe("Sign in to a Git host to create the repository.");
    expect(screen.getByTestId("create-project-remote-sign-in-gitlab").textContent).toBe("Sign In To GitLab");
    fireEvent.click(screen.getByTestId("create-project-remote-sign-in-github"));
    expect((await screen.findByTestId("source-control-link-warning")).textContent).toContain("Link GitHub?");
    fireEvent.click(screen.getByTestId("source-control-link-decline"));
    await waitFor(() => expect(screen.queryByTestId("source-control-link-warning")).toBeNull());
    // The New Project form stays, unsubmitted.
    expect(screen.getByTestId("create-project-dialog")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("create-project-submit").hasAttribute("disabled")).toBe(true);
  });

  it.each(["ios", "android"] as const)("keeps a Remote project in App Documents on %s, saying why Choose Folder is off", async (platform) => {
    render(<Composer hostPlatform={platform} initialHosting="local" />);
    fireEvent.click(screen.getByText("Options"));
    fireEvent.click(screen.getByTestId("create-project-choose-location"));
    expect(screen.getByTestId("create-project-choose-location").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("create-project-hosting-remote"));
    const chooseFolder = screen.getByTestId("create-project-choose-location");
    expect(chooseFolder.getAttribute("aria-pressed")).toBe("false");
    expect(chooseFolder.hasAttribute("disabled") || chooseFolder.getAttribute("aria-disabled") === "true").toBe(true);
    expect(screen.getByTestId("create-project-location").textContent)
      .toBe("Remote projects are created in App Documents: Haptic can't run Git in a folder you choose on this device.");
    await screen.findByTestId("create-project-remote-host");
  });

  it("lets a desktop Remote project use a folder it chooses, and offers no Hosting where there is no source control or when editing", async () => {
    const { unmount } = render(<Composer hostPlatform="electron" initialHosting="remote" />);
    fireEvent.click(screen.getByText("Options"));
    const chooseFolder = screen.getByTestId("create-project-choose-location");
    fireEvent.click(chooseFolder);
    expect(chooseFolder.getAttribute("aria-pressed")).toBe("true");
    await screen.findByTestId("create-project-remote-host");
    unmount();
    const noSourceControl = render(<Composer initialHosting={null} />);
    expect(screen.queryByTestId("create-project-hosting-local")).toBeNull();
    noSourceControl.unmount();
    render(<Composer mode="edit" initialHosting="remote" />);
    expect(screen.queryByTestId("create-project-hosting-remote")).toBeNull();
    expect(screen.queryByTestId("create-project-remote")).toBeNull();
  });

  it("fits the visible viewport during keyboard resizing without losing the draft", async () => {
    const viewport = Object.assign(new EventTarget(), {
      height: 844,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    render(<Composer />);
    const dialog = screen.getByTestId("create-project-dialog");
    const name = screen.getByTestId("create-project-name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Orbit" } });
    act(() => {
      viewport.height = 440;
      viewport.offsetTop = 12;
      viewport.dispatchEvent(new Event("resize"));
    });
    await waitFor(() =>
      expect(dialog.style.getPropertyValue("--homepage-visible-height")).toBe(
        "440px",
      ),
    );
    expect(dialog.style.getPropertyValue("--homepage-visible-top")).toBe(
      "12px",
    );
    expect(name.value).toBe("Orbit");
    // Pinch zoom must not squeeze the form into the magnified viewport.
    act(() => {
      viewport.scale = 2;
      viewport.height = 220;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--homepage-visible-height")).toBe(
      "440px",
    );
  });
  it.each(["(pointer: coarse)", "(any-pointer: coarse)"])(
    "focuses the popup on touch devices (%s) so opening it does not summon the keyboard",
    async (touchQuery) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === touchQuery,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }));
      render(<Composer />);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId("create-project-dialog"),
        ),
      );
      expect(document.activeElement).not.toBe(
        screen.getByTestId("create-project-name"),
      );
    },
  );

  it("offers Pixel Art Optimized, off by default, with its two design sizes once on", () => {
    render(<Composer />);
    fireEvent.click(screen.getByText("Options"));
    const option = screen.getByTestId("create-project-pixel-art");
    expect(option.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("create-project-pixel-art-size")).toBeNull();
    fireEvent.click(option);
    expect(screen.getByTestId("create-project-pixel-art-size")).toBeTruthy();
    expect((screen.getByTestId("create-project-width") as HTMLInputElement).value).toBe("640");
    fireEvent.click(screen.getByRole("button", { name: "320 × 180" }));
    expect((screen.getByTestId("create-project-width") as HTMLInputElement).value).toBe("320");
    expect((screen.getByTestId("create-project-height") as HTMLInputElement).value).toBe("180");
  });

  it("restores focus to project actions after editing from its context menu", async () => {
    function ContextEdit() {
      const [menuOpen, setMenuOpen] = useState(false);
      const [editOpen, setEditOpen] = useState(false);
      return (
        <>
          <button
            data-testid="project-actions"
            onClick={() => setMenuOpen(true)}
          >
            Project Actions
          </button>
          <ContextMenuOverlay
            menu={
              menuOpen
                ? {
                    open: true,
                    x: 20,
                    y: 20,
                    items: [
                      {
                        id: "edit",
                        label: "Edit Project",
                        onSelect: () => setEditOpen(true),
                      },
                    ],
                  }
                : null
            }
            onClose={() => setMenuOpen(false)}
          />
          <Composer mode="edit" open={editOpen} onOpenChange={setEditOpen} />
        </>
      );
    }
    render(<ContextEdit />);
    const trigger = screen.getByTestId("project-actions");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    const input = screen.getByTestId("homepage-rename-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("edits a saved identity without offering to replace its template or project settings", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="edit" onSubmit={onSubmit} />);
    expect(screen.getByRole("heading", { name: "Edit Project" })).toBeTruthy();
    expect(
      (screen.getByTestId("homepage-rename-input") as HTMLInputElement).value,
    ).toBe("Moon Garden");
    expect(screen.queryByTestId("create-project-templates")).toBeNull();
    expect(screen.queryByTestId("create-project-width")).toBeNull();
    expect(screen.queryByTestId("create-project-choose-location")).toBeNull();
    fireEvent.change(screen.getByTestId("homepage-rename-input"), {
      target: { value: "" },
    });
    expect(
      (screen.getByTestId("homepage-rename-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("homepage-rename-input"), {
      target: { value: "Sun Garden" },
    });
    fireEvent.click(screen.getByTestId("homepage-rename-confirm"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("rejects unsupported image files and retains the chosen badge", async () => {
    render(<Composer />);
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Garden" },
    });
    fireEvent.change(screen.getByLabelText("Upload Picture"), {
      target: {
        files: [new File(["<svg />"], "icon.svg", { type: "image/svg+xml" })],
      },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /PNG, JPEG, or WebP/,
    );
    expect(
      screen.getByTestId("project-identity-preview").querySelector("img"),
    ).toBeNull();
  });

  it("discards a late picture import after closing and allows the reopened form to submit", async () => {
    let resolvePicture!: (value: string) => void;
    vi.spyOn(appearanceHelpers, "prepareProjectPicture").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePicture = resolve;
        }),
    );
    const view = render(<Composer />);
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Garden" },
    });
    fireEvent.change(screen.getByLabelText("Upload Picture"), {
      target: {
        files: [
          new File([new Uint8Array(1)], "badge.png", { type: "image/png" }),
        ],
      },
    });
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    view.rerender(<Composer open={false} />);
    view.rerender(<Composer />);
    await act(async () => {
      resolvePicture("data:image/webp;base64,AAAA");
    });
    expect(
      screen.getByTestId("project-identity-preview").querySelector("img"),
    ).toBeNull();
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps a color chosen while a picture encodes and then shows the picture", async () => {
    let resolvePicture!: (value: string) => void;
    vi.spyOn(appearanceHelpers, "prepareProjectPicture").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePicture = resolve;
        }),
    );
    render(<Composer />);
    fireEvent.change(screen.getByLabelText("Upload Picture"), {
      target: {
        files: [
          new File([new Uint8Array(1)], "badge.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Violet" }));
    expect(
      screen.getByRole("button", { name: "Violet" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      resolvePicture("data:image/webp;base64,AAAA");
    });
    expect(
      screen.getByTestId("project-identity-preview").querySelector("img"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Violet" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the chosen template fixed while project creation is in progress", () => {
    render(<Composer busy />);
    expect(
      screen.getByRole("button", { name: "Choose Template" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Choose Template" }));
    expect(screen.queryByTestId("create-project-templates")).toBeNull();
  });

  it("guards submission and Escape dismissal while an edit is saving", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(
      <Composer
        mode="edit"
        busy
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.submit(screen.getByTestId("create-project-form"));
    fireEvent.keyDown(screen.getByTestId("homepage-rename-input"), {
      key: "Escape",
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    view.rerender(
      <Composer mode="edit" onSubmit={onSubmit} onOpenChange={onOpenChange} />,
    );
    fireEvent.submit(screen.getByTestId("create-project-form"));
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByTestId("homepage-rename-input"), {
      key: "Escape",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
