import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import {
  closeSettings,
  openContentBrowser,
  openMainScene,
  openTestProject,
  waitForEditorInteractive,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

// Integrated mode end to end on test mode's fake GitHub and in-memory remotes (`FakeSync`), which live for the
// page: Publish, Clone, an edit committed and pushed, then a pull whose conflict needs a choice. One page session.

const REPOSITORY = "https://github.com/test-user/testproject.git";
const SCENE_PATH = "assets/main.scene.hasset";

interface SyncHook {
  snapshot: () => { active: boolean; ahead: number; behind: number; rows: { id: string }[]; operation: unknown };
  teammateCommit: (url: string, changes: Record<string, string | null>, message?: string, branch?: string) => Promise<string>;
  remoteText: (url: string, path: string) => Promise<string | null>;
  remoteHeadMessage: (url: string) => Promise<string | null>;
}

type SyncHost = { __hapticSourceControlSync?: SyncHook };

function settled(page: Page) {
  return page.evaluate(() => {
    const snapshot = (globalThis as SyncHost).__hapticSourceControlSync!.snapshot();
    return { active: snapshot.active, ahead: snapshot.ahead, behind: snapshot.behind, rows: snapshot.rows.map((row) => row.id), busy: snapshot.operation !== null };
  });
}

function remoteText(page: Page, path: string) {
  return page.evaluate(([url, file]) => (globalThis as SyncHost).__hapticSourceControlSync!.remoteText(url, file), [REPOSITORY, path] as const);
}

function remoteHeadMessage(page: Page) {
  return page.evaluate((url) => (globalThis as SyncHost).__hapticSourceControlSync!.remoteHeadMessage(url), REPOSITORY);
}

function teammateCommit(page: Page, changes: Record<string, string | null>, message: string, branch = "main") {
  return page.evaluate(
    ([url, files, text, on]) => (globalThis as SyncHost).__hapticSourceControlSync!.teammateCommit(url, files, text, on),
    [REPOSITORY, changes, message, branch] as const,
  );
}

async function editAndSaveScene(page: Page): Promise<void> {
  const nudged = await page.evaluate(async () => {
    const host = globalThis as { __hapticTest?: { nudgeActiveSceneActor: () => Promise<boolean> } };
    return (await host.__hapticTest?.nudgeActiveSceneActor()) ?? false;
  });
  expect(nudged).toBe(true);
  await saveAllIfEnabled(page);
}

test.describe("Source Control in Integrated mode", () => {
  test("publishes, clones, commits and pushes, then pulls a teammate's change with a conflict", async ({ page }) => {
    test.setTimeout(240_000);
    await openTestProject(page);

    // Publish: sign in to the fake GitHub, create the repository and push the project.
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-sourceControl").click();
    await page.getByTestId("settings-source-control-publish").click();
    const publish = page.getByTestId("publish-project-dialog");
    await publish.getByTestId("publish-account-sign-in").click();
    await page.getByTestId("source-control-link-accept").click();
    await expect(publish.getByTestId("publish-account-signed-in")).toHaveText("Signed In As test-user", { timeout: 30_000 });
    await expect(publish.getByTestId("publish-name")).toHaveValue("testproject");
    await expect(publish.getByTestId("publish-reason")).toHaveCount(0);
    await publish.getByTestId("publish-submit").click();
    await expect(publish).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("settings-source-control-mode-integrated")).toHaveAttribute("aria-pressed", "true");
    await closeSettings(page);
    expect(await remoteText(page, "project.json")).toContain('"integrated"');
    await expect(page.getByTestId("status-source-control-changes")).toHaveText("0 Changes");

    // Clone it as a teammate's copy, which opens in Integrated mode.
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("clone-project").click();
    const clone = page.getByTestId("clone-project-dialog");
    await clone.getByTestId("clone-repository-test-user/testproject").click();
    // The repository's name is taken by the project it came from.
    await expect(clone.getByTestId("clone-reason")).toHaveText("A project with this name already exists.");
    await clone.getByTestId("clone-name").fill("Cloned Copy");
    await clone.getByTestId("clone-submit").click();
    await waitForEditorInteractive(page);
    await expect(page.getByTestId("status-source-control-menu")).toContainText("main");
    await expect.poll(() => settled(page), { timeout: 30_000 }).toEqual({ active: true, ahead: 0, behind: 0, rows: [], busy: false });

    // Edit, save (project.json must not count as a change), commit and push.
    await openContentBrowser(page);
    await openMainScene(page);
    await editAndSaveScene(page);
    // The save itself starts the status (FakeSync lists every file in OPFS, so allow it time).
    await expect(page.getByTestId("status-source-control-changes")).toHaveText("1 Change", { timeout: 30_000 });
    await expect(page.getByTestId("source-control-tab-count")).toHaveText("1");
    await page.getByTestId("status-source-control-changes").click();
    const changes = page.getByTestId("changes-panel").filter({ visible: true });
    await expect(changes.getByTestId(`changes-row-${SCENE_PATH}`)).toBeVisible();

    // The row opens the Scene's diff (HEAD against the working copy, on the diff worker); Revert Asset puts HEAD's version back.
    await changes.getByTestId(`changes-open-${SCENE_PATH}`).click();
    await expect(page.getByTestId("diff-actors-panel").filter({ visible: true }).getByTestId("diff-counts")).toHaveText("0 Added0 Removed1 Changed", { timeout: 30_000 });
    const diff = page.getByTestId("diff-panel").filter({ visible: true });
    await expect(diff.getByTestId("diff-properties").locator('[data-changed="true"]').first()).toBeVisible();
    await expect(page.getByTestId("diff-base")).toContainText("main ·");
    await expect(page.getByTestId("diff-compare")).toContainText("Working Copy");
    await diff.getByTestId("diff-revert").click();
    await expect(page.getByTestId("source-control-revert-confirm")).toContainText("It cannot be undone.");
    await page.getByTestId("source-control-revert-confirm-action").click();
    // Documents are editable again once the reverted Scene has reloaded.
    await expect(page.getByTestId("source-control-revert-running")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("status-source-control-changes")).toHaveText("0 Changes", { timeout: 30_000 });
    await editAndSaveScene(page);
    await expect(changes.getByTestId(`changes-row-${SCENE_PATH}`)).toBeVisible({ timeout: 30_000 });

    await changes.getByTestId("changes-commit-message").fill("Move the first actor");
    await expect(changes.getByTestId("changes-commit")).toHaveText("Commit 1 Asset");
    await changes.getByTestId("changes-commit").click();
    await expect.poll(() => remoteHeadMessage(page), { timeout: 30_000 }).toBe("Move the first actor");
    await expect.poll(() => settled(page), { timeout: 30_000 }).toEqual({ active: true, ahead: 0, behind: 0, rows: [], busy: false });

    // A teammate changes the same Scene and adds a file; this copy edits the Scene again.
    await teammateCommit(page, { [SCENE_PATH]: "teammate", "notes/teammate.txt": "hello" }, "Teammate edit");
    await editAndSaveScene(page);
    await expect(changes.getByTestId("changes-count")).toHaveText("1", { timeout: 30_000 });
    await changes.getByTestId("changes-refresh").click();
    await expect(changes.getByTestId("changes-pull")).toHaveText("Pull1", { timeout: 30_000 });
    await expect(changes.getByTestId("changes-incoming")).toContainText("Teammate edit");

    // Pull: confirmed, then one choice per asset changed on both sides before it applies.
    await changes.getByTestId("changes-pull").click();
    await page.getByTestId("source-control-pull-confirm-action").click();
    const conflicts = page.getByTestId("source-control-pull-conflicts");
    await expect(conflicts).toContainText("1 asset changed here and on main");
    await expect(conflicts.getByTestId("source-control-pull-conflicts-apply")).toBeDisabled();
    await expect(conflicts.getByTestId("source-control-pull-conflicts-reason")).toContainText("Choose a version for");
    await conflicts.getByTestId(`source-control-conflict-mine-${SCENE_PATH}`).click();
    await conflicts.getByTestId("source-control-pull-conflicts-apply").click();
    await expect(conflicts).toHaveCount(0, { timeout: 30_000 });
    // The teammate's file came in; the kept Scene is still this copy's uncommitted change.
    await expect.poll(() => settled(page), { timeout: 30_000 }).toEqual({ active: true, ahead: 0, behind: 0, rows: [SCENE_PATH], busy: false });
    await expect(page.getByTestId("status-source-control-changes")).toHaveText("1 Change");

    // A teammate's branch, listed from the remote: switching writes its files and keeps the Scene's edit, which both branches hold alike.
    await teammateCommit(page, { "notes/art.txt": "art" }, "Art notes", "art");
    await page.getByTestId("status-source-control-menu").click();
    await page.getByTestId("status-source-control-switch-branch").click();
    await page.getByTestId("status-source-control-remote-art").click();
    await expect(page.getByTestId("source-control-switch-confirm")).toContainText("Switch To art?");
    await page.getByTestId("source-control-switch-confirm-action").click();
    await expect(page.getByTestId("source-control-switch-running")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("status-source-control-menu")).toContainText("art");
    // Still only the Scene: the checked-out branch is the working copy's, so the switch changed no project.json.
    await expect.poll(() => settled(page), { timeout: 30_000 }).toEqual({ active: true, ahead: 0, behind: 0, rows: [SCENE_PATH], busy: false });

    // History of the Scene being edited, then of the whole branch.
    await page.getByTestId("status-source-control-menu").click();
    await page.getByTestId("status-source-control-history").click();
    const history = page.getByTestId("history-panel").filter({ visible: true });
    await expect(history.getByTestId("history-list")).toContainText("Teammate edit", { timeout: 30_000 });
    await expect(history.getByTestId("history-list")).not.toContainText("Art notes");
    await history.getByTestId("history-scope-all").click();
    await expect(history.getByTestId("history-list")).toContainText("Art notes");
    await history.getByText("Art notes").click();
    await expect(history.getByTestId("history-details")).toContainText("Teammate");
    await expect(history.getByTestId("history-assets")).toContainText("art");
  });
});
