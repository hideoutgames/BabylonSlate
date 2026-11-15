import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelledError, SyncError } from "@haptic/source-control";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import type { TransferMonitor } from "../services/source-control-sync";
import { signedInHosts } from "../testing/source-control-hosts";
import CloneProjectDialog from "./clone-project-dialog";

const state = vi.hoisted(() => ({ accounts: null as SourceControlAccounts | null }));

vi.mock("../services/source-control-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/source-control-accounts")>();
  return { ...actual, sourceControlAccounts: async () => state.accounts! };
});

beforeEach(async () => {
  state.accounts = await signedInHosts(new FakeGitHost().http);
});

afterEach(() => {
  cleanup();
});

async function chooseGame() {
  fireEvent.click(await screen.findByTestId("clone-repository-haptic-test/game"));
  await waitFor(() => expect(screen.getByTestId("clone-branch").getAttribute("role")).toBe("combobox"));
}

describe("Clone Project", () => {
  it("clones the chosen repository's branch under a project name taken from it", async () => {
    const onClone = vi.fn(async () => {});
    render(<CloneProjectDialog open onOpenChange={() => {}} existingNames={[]} onClone={onClone} />);
    expect((await screen.findByTestId("clone-account-signed-in")).textContent).toBe("Signed In As ada");
    const game = await screen.findByTestId("clone-repository-haptic-test/game");
    expect(game.textContent).toContain("Private");
    expect(game.textContent).toContain("Updated");
    fireEvent.change(screen.getByTestId("clone-search"), { target: { value: "proto" } });
    expect(screen.queryByTestId("clone-repository-haptic-test/game")).toBeNull();
    fireEvent.change(screen.getByTestId("clone-search"), { target: { value: "" } });
    await chooseGame();
    expect((screen.getByTestId("clone-name") as HTMLInputElement).value).toBe("Game");
    await act(async () => {
      fireEvent.click(screen.getByTestId("clone-submit"));
    });
    expect(onClone).toHaveBeenCalledWith(
      { repositoryUrl: "https://github.com/haptic-test/game.git", branch: "main", name: "Game" },
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("refuses a project name that is already listed", async () => {
    render(<CloneProjectDialog open onOpenChange={() => {}} existingNames={["game"]} onClone={vi.fn()} />);
    await chooseGame();
    expect(screen.getByTestId("clone-reason").textContent).toBe("A project with this name already exists.");
    expect(screen.getByTestId("clone-submit").hasAttribute("disabled")).toBe(true);
  });

  it("cancels a running clone through its signal, and shows no error for the cancel", async () => {
    let transfer!: TransferMonitor;
    let signal!: AbortSignal;
    const onClone = vi.fn((_request: unknown, monitor: TransferMonitor, cancel: AbortSignal) => {
      transfer = monitor;
      signal = cancel;
      // As the Git client ends a cancelled clone.
      return new Promise<void>((_resolve, reject) => {
        cancel.addEventListener("abort", () => reject(cancelledError()));
      });
    });
    render(<CloneProjectDialog open onOpenChange={() => {}} existingNames={[]} onClone={onClone} />);
    await chooseGame();
    fireEvent.click(screen.getByTestId("clone-submit"));
    act(() => transfer.bytes(2048));
    await waitFor(() => expect(screen.getByTestId("clone-progress").textContent).toContain("2 KB received"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("clone-cancel"));
    });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByTestId("clone-progress")).toBeNull();
    expect(screen.queryByTestId("clone-error")).toBeNull();
  });

  it("shows the bytes received without re-rendering for every request", async () => {
    let transfer!: TransferMonitor;
    const onClone = vi.fn((_request: unknown, monitor: TransferMonitor) => {
      transfer = monitor;
      return new Promise<void>(() => {});
    });
    let commits = 0;
    render(
      <Profiler id="clone" onRender={() => { commits += 1; }}>
        <CloneProjectDialog open onOpenChange={() => {}} existingNames={[]} onClone={onClone} />
      </Profiler>,
    );
    await chooseGame();
    fireEvent.click(screen.getByTestId("clone-submit"));
    await waitFor(() => expect(screen.getByTestId("clone-progress")).toBeTruthy());
    commits = 0;
    // Each request of an LFS download ends on its own.
    for (let request = 0; request < 200; request += 1) act(() => transfer.bytes(1024));
    await waitFor(() => expect(screen.getByTestId("clone-progress").textContent).toContain("200 KB received"));
    expect(commits).toBeLessThan(10);
  });

  it("reports a clone that fails for another reason", async () => {
    const onClone = vi.fn(async () => {
      throw new SyncError("network", "The Git server could not be reached.");
    });
    render(<CloneProjectDialog open onOpenChange={() => {}} existingNames={[]} onClone={onClone} />);
    await chooseGame();
    await act(async () => {
      fireEvent.click(screen.getByTestId("clone-submit"));
    });
    expect(screen.getByTestId("clone-error").textContent).toContain("The Git server could not be reached.");
  });

  it("takes any host by URL, asking for a token where there is no device sign-in", async () => {
    render(<CloneProjectDialog open onOpenChange={() => {}} existingNames={[]} onClone={vi.fn()} />);
    fireEvent.click(screen.getByTestId("clone-host-url"));
    fireEvent.change(screen.getByTestId("clone-url"), { target: { value: "https://git.example.com/team/racer.git" } });
    expect((screen.getByTestId("clone-name") as HTMLInputElement).value).toBe("Racer");
    expect(screen.getByTestId("clone-reason").textContent).toBe("Add a token for git.example.com in Engine Settings → Source Control.");
  });
});
