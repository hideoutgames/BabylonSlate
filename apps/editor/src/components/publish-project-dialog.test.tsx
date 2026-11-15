import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "@haptic/core";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import type { OpenDocument } from "../services/document-service";
import { signedInHosts } from "../testing/source-control-hosts";
import PublishProjectDialog from "./publish-project-dialog";

const state = vi.hoisted(() => ({
  accounts: null as SourceControlAccounts | null,
  dirty: [] as OpenDocument[],
  publishProject: vi.fn<(request: { repositoryUrl: string; branch: string }) => Promise<void>>(async () => {}),
  // Actions keep their identity, as the provider's do.
  summarize: vi.fn(async () => ({ assets: 312, bytes: 840 * 1024 * 1024, lfsBytes: 790 * 1024 * 1024 })),
}));

vi.mock("../services/source-control-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/source-control-accounts")>();
  return { ...actual, sourceControlAccounts: async () => state.accounts! };
});

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    projectDocument: createEmptyProject("Forest Run"),
    dirtyDocuments: state.dirty,
    publishProject: state.publishProject,
    summarizeProjectForPublish: state.summarize,
  })),
);

let host: FakeGitHost;

beforeEach(async () => {
  host = new FakeGitHost();
  state.accounts = await signedInHosts(host.http);
});

afterEach(() => {
  cleanup();
  state.dirty = [];
  state.publishProject.mockClear();
});

describe("Publish Project", () => {
  it("creates the repository under the chosen owner, then publishes the project to it", async () => {
    const onOpenChange = vi.fn();
    render(<PublishProjectDialog open onOpenChange={onOpenChange} />);
    expect((await screen.findByTestId("publish-account-signed-in")).textContent).toBe("Signed In As ada");
    expect((screen.getByTestId("publish-name") as HTMLInputElement).value).toBe("forest-run");
    await waitFor(() => expect(screen.getByTestId("publish-summary").textContent).toContain("Creates github.com/test-user/forest-run"));
    expect(screen.getByTestId("publish-summary-push").textContent).toBe("Pushes 312 assets, 840.0 MB (790.0 MB through Git LFS)");
    fireEvent.click(screen.getByTestId("publish-public"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-submit"));
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(host.repositories[0]).toBe("test-user/forest-run");
    expect(host.publicRepositories.has("test-user/forest-run")).toBe(true);
    expect(state.publishProject).toHaveBeenCalledWith({ repositoryUrl: "https://github.com/test-user/forest-run.git", branch: "main" });
  });

  it("publishes under the signed-in user when the host will not list their organizations", async () => {
    host.organizationsRefused = true;
    render(<PublishProjectDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("publish-summary").textContent).toContain("Creates github.com/test-user/forest-run"));
    expect(screen.queryByTestId("publish-error")).toBeNull();
    expect(screen.queryByTestId("publish-reason")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-submit"));
    });
    await waitFor(() => expect(state.publishProject).toHaveBeenCalledWith({ repositoryUrl: "https://github.com/test-user/forest-run.git", branch: "main" }));
  });

  it("names why Publish waits: unsaved documents, or no account for the host", async () => {
    state.dirty = [{ id: "scene:a", ref: { kind: "scene", path: "assets/a.scene.hasset", label: "A" }, content: {}, layout: null, dirty: true }];
    render(<PublishProjectDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("publish-reason").textContent).toBe("Save All before publishing."));
    expect(screen.getByTestId("publish-submit").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("publish-host-gitlab"));
    expect(screen.getByTestId("publish-reason").textContent).toBe("Sign in to GitLab to publish.");
  });

  it("refuses a name taken by a repository that is not empty, and publishes nothing", async () => {
    host.repositories.unshift("test-user/forest-run");
    host.repositoryBranches.set("test-user/forest-run", ["main"]);
    render(<PublishProjectDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("publish-reason")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-submit"));
    });
    expect((await screen.findByTestId("publish-error")).textContent).toContain("test-user/forest-run already exists and is not empty. Choose another repository name.");
    expect(state.publishProject).not.toHaveBeenCalled();
  });

  it("publishes again under the same name into the empty repository an interrupted Publish created", async () => {
    const onOpenChange = vi.fn();
    // The first attempt created the repository, then stopped before its push.
    state.publishProject.mockRejectedValueOnce(new Error("The host could not be reached."));
    const first = render(<PublishProjectDialog open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.queryByTestId("publish-reason")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-submit"));
    });
    expect((await screen.findByTestId("publish-error")).textContent).toContain("The host could not be reached.");
    first.unmount();

    render(<PublishProjectDialog open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.queryByTestId("publish-reason")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-submit"));
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId("publish-error")).toBeNull();
    expect(state.publishProject.mock.calls).toEqual([
      [{ repositoryUrl: "https://github.com/test-user/forest-run.git", branch: "main" }],
      [{ repositoryUrl: "https://github.com/test-user/forest-run.git", branch: "main" }],
    ]);
    expect(host.repositories.filter((name) => name === "test-user/forest-run")).toHaveLength(1);
  });
});
