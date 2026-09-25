import { StrictMode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryAppSettingsStore } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import { AppSettingsProvider } from "../context/app-settings-context";
import { ReleaseNews } from "./release-news";

const releases = [
  { version: "1.2.0", title: "Project Improvements", changes: ["Projects reopen faster."] },
  { version: "1.1.0", title: "Editor Fixes", changes: ["Saving is more reliable."] },
];
function Launcher({ store, version = "1.2.0" }: { store: MemoryAppSettingsStore; version?: string }) {
  const [open, setOpen] = useState(false);
  return <StrictMode><AppSettingsProvider store={store}>
    <Button onClick={() => setOpen(true)}>Open History</Button>
    <ReleaseNews open={open} onOpenChange={setOpen} announce version={version} releases={releases} />
  </AppSettingsProvider></StrictMode>;
}
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("announces the deployed web preview even when it uses QA project storage", async () => {
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_TEST_MODE", "true");
  render(<AppSettingsProvider store={new MemoryAppSettingsStore()}>
    <ReleaseNews open={false} onOpenChange={() => {}} version="1.2.0" releases={releases} />
  </AppSettingsProvider>);
  expect(await screen.findByRole("dialog", { name: "What's New" })).toBeTruthy();
});

it("shows current notes once per version, then permits reopening the full history", async () => {
  const store = new MemoryAppSettingsStore();
  const first = render(<Launcher store={store} />);
  const news = await screen.findByRole("dialog", { name: "What's New" });
  expect(within(news).getByText("Projects reopen faster.")).toBeTruthy();
  expect(within(news).queryByText("Saving is more reliable.")).toBeNull();
  expect((await store.load()).seenReleaseVersions).toEqual([]);
  fireEvent.click(within(news).getByRole("button", { name: "Done" }));
  await waitFor(async () => expect((await store.load()).seenReleaseVersions).toEqual(["1.2.0"]));
  first.unmount();

  render(<Launcher store={store} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open History" }));
  const history = await screen.findByRole("dialog", { name: "Changelog" });
  expect(within(history).getByText("Projects reopen faster.")).toBeTruthy();
  expect(within(history).getByText("Saving is more reliable.")).toBeTruthy();
});

it("announces an unseen version after an earlier dismissal without repeating on return", async () => {
  const store = new MemoryAppSettingsStore();
  await store.update(settings => { settings.seenReleaseVersions = ["1.1.0"]; settings.automaticUpdatesEnabled = false; });
  const view = render(<Launcher store={store} />);
  const news = await screen.findByRole("dialog", { name: "What's New" });
  fireEvent.click(within(news).getByRole("button", { name: "Close" }));
  await waitFor(async () => expect((await store.load()).seenReleaseVersions).toEqual(["1.1.0", "1.2.0"]));
  expect((await store.load()).automaticUpdatesEnabled).toBe(false);
  view.unmount();
  render(<Launcher store={store} version="1.1.0" />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("waits for stored preferences before deciding whether this is the first launch", async () => {
  const store = new MemoryAppSettingsStore();
  await store.update(settings => { settings.seenReleaseVersions = ["1.2.0"]; });
  const stored = await store.load();
  let finish!: (settings: typeof stored) => void;
  store.load = () => new Promise(resolve => { finish = resolve; });
  render(<Launcher store={store} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => finish(stored));
  expect(screen.queryByRole("dialog")).toBeNull();
});
