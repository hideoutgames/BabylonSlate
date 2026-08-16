import { expect, type ConsoleMessage, type Page } from "@playwright/test";

const PAGE_FAILURE_RE = /disposed|ADT pick failed|undefined/i;

export type PageFailureCollector = {
  listenForUnhandledRejections: () => Promise<void>;
  messages: () => Promise<string[]>;
};

export type UiHostStatsSnapshot = {
  apply: number;
  create: number;
  present: number;
  commit: number;
};

/** Record pageerror, matching console errors, and (after listen) unhandledrejections. */
export function attachPageFailureCollector(page: Page): PageFailureCollector {
  const recorded: string[] = [];

  page.on("pageerror", (error) => {
    recorded.push(error.message || String(error));
  });

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (PAGE_FAILURE_RE.test(text)) recorded.push(text);
  });

  return {
    async listenForUnhandledRejections() {
      await page.evaluate(() => {
        const w = window as Window & {
          __babylonslateUnhandled?: string[];
          __babylonslateUnhandledBound?: boolean;
        };
        if (w.__babylonslateUnhandledBound) return;
        w.__babylonslateUnhandledBound = true;
        w.__babylonslateUnhandled ??= [];
        window.addEventListener("unhandledrejection", (event) => {
          const reason = event.reason as unknown;
          const text =
            reason instanceof Error
              ? reason.message
              : typeof reason === "string"
                ? reason
                : String(reason ?? "undefined");
          w.__babylonslateUnhandled!.push(text);
        });
      });
    },
    async messages() {
      let extra: string[] = [];
      try {
        extra = await page.evaluate(() => {
          const w = window as Window & { __babylonslateUnhandled?: string[] };
          const list = [...(w.__babylonslateUnhandled ?? [])];
          if (w.__babylonslateUnhandled) w.__babylonslateUnhandled.length = 0;
          return list;
        });
      } catch {
        extra = [];
      }
      recorded.push(...extra);
      return [...recorded];
    },
  };
}

export async function assertNoPageFailures(
  collector: PageFailureCollector,
): Promise<void> {
  const messages = await collector.messages();
  const critical = messages.filter((message) => PAGE_FAILURE_RE.test(message));
  expect(critical, messages.join("\n")).toEqual([]);
}

export async function readUiHostStats(page: Page): Promise<UiHostStatsSnapshot> {
  return page.evaluate(() => {
    const stats = (
      window as Window & {
        __babylonslateUiHostStats?: {
          apply: number;
          create: number;
          present: number;
          commit: number;
        };
      }
    ).__babylonslateUiHostStats;
    return {
      apply: stats?.apply ?? 0,
      create: stats?.create ?? 0,
      present: stats?.present ?? 0,
      commit: stats?.commit ?? 0,
    };
  });
}
