import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomepageDiscordBadge } from "./homepage-discord-badge";

const badge = () => screen.queryByRole("link", { name: "Join our Discord" });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Homepage Discord badge", () => {
  it("hides for a signed-in account after its first click, on this device only for that account", () => {
    const first = render(<HomepageDiscordBadge accountId="user_ada" />);
    fireEvent.click(badge()!);
    expect(badge()).toBeNull();
    first.unmount();

    // A later launch on this device remembers it for that account only.
    const again = render(<HomepageDiscordBadge accountId="user_ada" />);
    expect(badge()).toBeNull();
    again.rerender(<HomepageDiscordBadge accountId="user_grace" />);
    expect(badge()).not.toBeNull();
  });

  it("stays for guests, and waits until the account is known", () => {
    const { rerender } = render(<HomepageDiscordBadge accountId={undefined} />);
    expect(badge()).toBeNull();
    rerender(<HomepageDiscordBadge accountId={null} />);
    fireEvent.click(badge()!);
    expect(badge()).not.toBeNull();
  });
});
