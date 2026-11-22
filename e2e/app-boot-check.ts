import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserType } from "@playwright/test";

/** The start page mounts within seconds; a broken bundle never mounts it. */
export const APP_BOOT_TIMEOUT_MS = 30_000;

/**
 * Loads the editor's start page once and throws when it does not boot: an uncaught page error (a chunk that throws
 * while it evaluates, such as `Class extends value undefined`) fails at once with its text, and a root that does not
 * mount the start page fails after `timeoutMs`. Console messages are ignored. A run whose app cannot start fails here
 * in seconds instead of in every test's own timeout.
 *
 * An on-disk profile, as `profile-context.ts` uses for WebKit, whose ephemeral contexts have no origin-private file
 * system. Nothing it stores reaches the tests' contexts.
 */
export async function assertAppBoots(
  browserType: BrowserType,
  baseURL: string,
  options: { channel?: string; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? APP_BOOT_TIMEOUT_MS;
  const url = new URL("/?test=1", baseURL).href;
  const profile = await mkdtemp(path.join(tmpdir(), "haptic-boot-"));
  const context = await browserType.launchPersistentContext(profile, {
    ...(options.channel ? { channel: options.channel } : {}),
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let reject!: (error: Error) => void;
    const pageError = new Promise<never>((_, fail) => {
      reject = fail;
    });
    page.on("pageerror", (error) =>
      reject(new Error(`The editor did not boot: uncaught error while loading ${url}\n${error.stack ?? error.message}`)),
    );
    const mounted = (async () => {
      await page.goto(url, { timeout: timeoutMs });
      await page.getByTestId("homepage").waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {
        throw new Error(`The editor did not boot: its start page did not mount within ${timeoutMs / 1000} s at ${url}`);
      });
    })();
    // Whichever settles second is no longer awaited.
    mounted.catch(() => {});
    pageError.catch(() => {});
    await Promise.race([mounted, pageError]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}
