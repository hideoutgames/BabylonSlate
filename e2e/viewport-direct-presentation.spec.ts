import { test } from "@playwright/test";
import { directViewportStaysNonBlank } from "./direct-presentation-probe";

test("a directly presented viewport stays non-blank across held frames and a resize", async ({ page }) => {
  test.setTimeout(120_000);
  await directViewportStaysNonBlank(page, "webgl2");
});
