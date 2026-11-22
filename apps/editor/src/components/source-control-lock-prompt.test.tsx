import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FakeLockProvider } from "@haptic/source-control";
import { SourceControlService } from "../services/source-control-service";
import type { OpenDocument } from "../services/document-service";
import { MANUAL_SOURCE_CONTROL, signedInHosts } from "../testing/source-control-hosts";
import { dispatchPointerEvent } from "@haptic/editor-kit/test-support/pointer-events";
import { SourceControlLockPrompt } from "./source-control-lock-prompt";

const state = vi.hoisted(() => ({
  service: null as import("../services/source-control-service").SourceControlService | null,
  version: 0,
  documents: [] as import("../services/document-service").OpenDocument[],
}));

vi.mock("../context/document-context", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => state.service!.subscribe(() => {
    state.version += 1;
    listener();
  });
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    // The provider's source control slice changes whenever the service does.
    useSyncExternalStore(subscribe, () => state.version);
    return { sourceControl: state.service!, openDocuments: state.documents };
  });
});

const HERO = "assets/Hero.class.hasset";
const ROCK = "assets/Rock.texture.hasset";

function openDocument(path: string, label: string): OpenDocument {
  return { id: `graph:${path}`, ref: { kind: "graph", path, label }, content: null, dirty: true } as OpenDocument;
}

async function askingService(): Promise<{ service: SourceControlService; fake: FakeLockProvider }> {
  const service = new SourceControlService();
  service.pausePolling();
  const fake = new FakeLockProvider({ selfName: "Ada" });
  await service.configure({
    settings: { ...MANUAL_SOURCE_CONTROL, lockOnEdit: "ask" },
    projectKey: "proj",
    platform: "electron",
    testMode: true,
    hosts: await signedInHosts(),
    fake,
  });
  await service.refresh();
  state.service = service;
  return { service, fake };
}

afterEach(() => {
  cleanup();
  state.service?.dispose();
  state.service = null;
  state.documents = [];
});

describe("SourceControlLockPrompt", () => {
  it("asks about an edited file by its tab name, focusing the prompt rather than an action, and Lock locks it", async () => {
    const { service } = await askingService();
    state.documents = [openDocument(HERO, "Hero Class")];
    render(<SourceControlLockPrompt />);
    expect(screen.queryByTestId("source-control-lock-prompt")).toBeNull();

    await act(() => service.onEdit(HERO));
    const prompt = await screen.findByTestId("source-control-lock-prompt");
    expect(within(prompt).getByText("Lock Hero Class?")).toBeTruthy();
    // A key typed as the prompt appears reaches no button: Enter or Space cannot answer it.
    await waitFor(() => expect(document.activeElement).toBe(prompt));
    fireEvent.keyDown(prompt, { key: "Enter" });
    fireEvent.keyDown(prompt, { key: " " });
    expect(screen.getByTestId("source-control-lock-prompt")).toBeTruthy();
    expect(service.lockStateForPath(HERO)).toBeNull();

    fireEvent.click(within(prompt).getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(service.lockStateForPath(HERO)).toBe("mine"));
    await waitFor(() => expect(screen.queryByTestId("source-control-lock-prompt")).toBeNull());
  });

  it("lists the files one operation edited in one prompt, and Don't Lock leaves them all unlocked", async () => {
    const { service, fake } = await askingService();
    state.documents = [openDocument(HERO, "Hero Class")];
    render(<SourceControlLockPrompt />);
    await act(async () => {
      await service.onEdit(HERO);
      await service.onEdit(ROCK);
    });
    const prompt = await screen.findByTestId("source-control-lock-prompt");
    expect(within(prompt).getByText("Lock 2 Files?")).toBeTruthy();
    expect(within(screen.getByTestId("source-control-lock-prompt-files")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Hero Class", "Rock.texture.hasset"]);

    fireEvent.click(within(prompt).getByRole("button", { name: "Don't Lock" }));
    await waitFor(() => expect(screen.queryByTestId("source-control-lock-prompt")).toBeNull());
    expect(service.lockPrompt).toEqual([]);
    expect(fake.createCount).toBe(0);
  });

  it("waits for a pressed pointer to be released before asking, so a drag ends first", async () => {
    const { service } = await askingService();
    render(<SourceControlLockPrompt />);
    dispatchPointerEvent(document.body, "pointerdown", { pointerId: 7, pointerType: "mouse", buttons: 1 });
    await act(() => service.onEdit(HERO));
    expect(screen.queryByTestId("source-control-lock-prompt")).toBeNull();

    act(() => dispatchPointerEvent(document.body, "pointerup", { pointerId: 7, pointerType: "mouse" }));
    const prompt = await screen.findByTestId("source-control-lock-prompt");
    expect(prompt.textContent).toContain("Lock Hero.class.hasset?");

    // Pressing its own Lock button keeps it open for the click.
    const lock = within(prompt).getByRole("button", { name: "Lock" });
    act(() => dispatchPointerEvent(lock, "pointerdown", { pointerId: 8, pointerType: "mouse", buttons: 1 }));
    expect([prompt.hasAttribute("data-open"), prompt.hasAttribute("data-closed")]).toEqual([true, false]);
    act(() => dispatchPointerEvent(lock, "pointerup", { pointerId: 8, pointerType: "mouse" }));
    fireEvent.click(lock);
    await waitFor(() => expect(service.lockStateForPath(HERO)).toBe("mine"));
  });

  it("treats Escape as Don't Lock", async () => {
    const { service, fake } = await askingService();
    render(<SourceControlLockPrompt />);
    await act(() => service.onEdit(HERO));
    const prompt = await screen.findByTestId("source-control-lock-prompt");
    fireEvent.keyDown(prompt, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("source-control-lock-prompt")).toBeNull());
    expect(service.lockPrompt).toEqual([]);
    expect(fake.createCount).toBe(0);
  });
});
