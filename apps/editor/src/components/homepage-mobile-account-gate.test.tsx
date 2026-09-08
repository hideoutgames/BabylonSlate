import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HomepageMobileAccountGate } from "./homepage-mobile-account-gate";

const auth = vi.hoisted(() => ({
  host: "web",
  loaded: true,
  status: "signed-out" as string,
  failed: false,
  provider: vi.fn(),
}));

vi.mock("@babylonslate/vfs", async (original) => ({
  ...(await original<typeof import("@babylonslate/vfs")>()),
  getHostPlatform: () => auth.host,
}));
vi.mock("@clerk/react", () => ({
  ClerkProvider: (props: { children: ReactNode }) => {
    auth.provider(props);
    return props.children;
  },
  ClerkLoading: ({ children }: { children: ReactNode }) =>
    !auth.loaded && !auth.failed ? children : null,
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    auth.failed ? children : null,
  ClerkLoaded: ({ children }: { children: ReactNode }) =>
    auth.loaded && !auth.failed ? children : null,
  useSession: () => ({
    isLoaded: auth.loaded,
    isSignedIn: auth.status === "active",
    session: auth.status === "signed-out" ? null : { status: auth.status },
  }),
  SignIn: () => <div>Clerk Sign In</div>,
}));

afterEach(() => {
  cleanup();
  auth.host = "web";
  auth.loaded = true;
  auth.status = "signed-out";
  auth.failed = false;
  auth.provider.mockClear();
  vi.unstubAllEnvs();
});

describe("native mobile account requirement", () => {
  it.each(["web", "electron"])(
    "keeps %s project access available without an account",
    (host) => {
      auth.host = host;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
      render(
        <HomepageMobileAccountGate>
          <button>Create Project</button>
        </HomepageMobileAccountGate>,
      );
      expect(
        screen.getByRole("button", { name: "Create Project" }),
      ).toBeTruthy();
      expect(auth.provider).not.toHaveBeenCalled();
    },
  );

  it.each(["ios", "android"])(
    "requires configuration and sign-in on %s",
    (host) => {
      auth.host = host;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
      render(
        <HomepageMobileAccountGate>
          <button>Create Project</button>
        </HomepageMobileAccountGate>,
      );
      expect(
        screen.queryByRole("button", { name: "Create Project" }),
      ).toBeNull();
      expect(
        screen.getByRole("heading", { name: "Sign-In Is Not Set Up" }),
      ).toBeTruthy();
      expect(auth.provider).not.toHaveBeenCalled();
    },
  );

  it("only mounts project actions with a fully active native session", async () => {
    auth.host = "ios";
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    const children = <button>Create Project</button>;
    const view = render(
      <HomepageMobileAccountGate>{children}</HomepageMobileAccountGate>,
    );
    expect(await screen.findByText("Clerk Sign In")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    auth.status = "pending";
    view.rerender(
      <HomepageMobileAccountGate>{children}</HomepageMobileAccountGate>,
    );
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    auth.status = "active";
    view.rerender(
      <HomepageMobileAccountGate>{children}</HomepageMobileAccountGate>,
    );
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
    expect(auth.provider).toHaveBeenCalledWith(
      expect.objectContaining({ standardBrowser: false }),
    );
    auth.status = "signed-out";
    view.rerender(
      <HomepageMobileAccountGate>{children}</HomepageMobileAccountGate>,
    );
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
  });

  it("keeps native project actions unavailable if account loading fails", async () => {
    auth.host = "android";
    auth.failed = true;
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    render(
      <HomepageMobileAccountGate>
        <button>Create Project</button>
      </HomepageMobileAccountGate>,
    );
    expect(await screen.findByText(/could not connect/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
  });
});
