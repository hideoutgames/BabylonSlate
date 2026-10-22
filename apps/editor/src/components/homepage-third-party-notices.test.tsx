import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryAppSettingsStore } from "@haptic/vfs";
import { AppSettingsProvider } from "../context/app-settings-context";
import { ApplicationSettingsFields } from "./homepage-application-settings";
import { ThirdPartyNoticesPage, type ThirdPartyNotices } from "./homepage-third-party-notices";

afterEach(cleanup);

const notices: ThirdPartyNotices = {
  packages: [
    { name: "@babylonjs/havok", version: "1.3.14", license: "MIT", source: "https://example.com/havok", inGames: true, text: 0 },
    { name: "react", version: "19.2.8", license: "MIT", source: "", inGames: false, text: 1 },
  ],
  texts: ["Copyright (c) 2023 Babylon.js", "Copyright (c) Meta Platforms, Inc."],
};

describe("Third-Party Notices", () => {
  it("opens from the bottom of Application and returns with Back", async () => {
    const view = render(
      <AppSettingsProvider store={new MemoryAppSettingsStore()}>
        <ApplicationSettingsFields />
      </AppSettingsProvider>,
    );
    const legends = [...view.container.querySelectorAll("legend")].map(legend => legend.textContent);
    expect(legends.at(-1)).toBe("Legal");

    fireEvent.click(view.getByTestId("application-third-party-notices"));
    await waitFor(() => expect(view.getByRole("list", { name: "Third-Party Notices" })).toBeTruthy());
    expect(view.getByText("@babylonjs/havok")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Application" }));
    expect(view.getByTestId("application-third-party-notices")).toBeTruthy();
  });

  it("marks what ships in games and shows one licence at a time", async () => {
    const view = render(<ThirdPartyNoticesPage onBack={() => {}} load={async () => notices} />);
    const havok = await view.findByRole("button", { name: /@babylonjs\/havok/ });
    const react = view.getByRole("button", { name: /react/ });
    expect(havok.textContent).toContain("In Games");
    expect(react.textContent).not.toContain("In Games");
    expect(view.queryByText(notices.texts[0])).toBeNull();

    fireEvent.click(havok);
    expect(view.getByText(notices.texts[0])).toBeTruthy();
    fireEvent.click(react);
    expect(view.queryByText(notices.texts[0])).toBeNull();
    expect(view.getByText(notices.texts[1])).toBeTruthy();
  });

  it("explains a failed load", async () => {
    const view = render(<ThirdPartyNoticesPage onBack={() => {}} load={() => Promise.reject(new Error("offline"))} />);
    expect(await view.findByText(/could not be loaded/)).toBeTruthy();
  });
});
