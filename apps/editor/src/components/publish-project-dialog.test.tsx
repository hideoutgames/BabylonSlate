import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "@haptic/core";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import type { OpenDocument } from "../services/document-service";
import type { NewRepositoryRequest, PublishOutcome } from "../services/source-control-publish";
import { signedInHosts } from "../testing/source-control-hosts";
import PublishProjectDialog from "./publish-project-dialog";

const state = vi.hoisted(() => ({
  accounts: null as SourceControlAccounts | null,
  dirty: [] as OpenDocument[],
  publish: vi.fn<(request: NewRepositoryRequest) => Promise<PublishOutcome>>(async () => ({ status: "published", repositoryUrl: "https://github.com/test-user/forest-run.git" })),
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
    publishToNewRepository: state.publish,
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
  state.publish.mockClear();
});

describe("Publish Project", () => {
  it("publishes the project to a new repository under the chosen owner", async () => {
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
    expect(state.publish).toHaveBeenCalledWith({
      origin: "https://github.com",
      owner: { name: "test-user", kind: "user", id: "" },
      name: "forest-run",
      private: false,
    });
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
    await waitFor(() => expect(state.publish).toHaveBeenCalledWith(expect.objectContaining({ owner: { name: "test-user", kind: "user", id: "" } })));
  });

  it("names why Publish waits: unsaved documents, or no account for the host", async () => {
    state.dirty = [{ id: "scene:a", ref: { kind: "scene", path: "assets/a.scene.hasset", label: "A" }, content: {}, layout: null, dirty: true }];
    render(<PublishProjectDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("publish-reason").textContent).toBe("Save All before publishing."));
    expect(screen.getByTestId("publish-submit").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("publish-host-gitlab"));
    expect(screen.getByTestId("publish-reason").textContent).toBe("Sign in to GitLab to publish.");
  });

  it("stays open with why Publish stopped, so it can be tried again", async () => {
    const onOpenChange = vi.fn();
    state.publish.mockResolvedValueOnce({ status: "local", message: "test-user/forest-run already exists and is not empty. Choose another repository name." });
    render(<PublishProjectDialog open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.queryByTestId("publish-reason")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-submit"));
    });
    expect((await screen.findByTestId("publish-error")).textContent).toContain("test-user/forest-run already exists and is not empty. Choose another repository name.");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-submit").hasAttribute("disabled")).toBe(false);
  });
});
