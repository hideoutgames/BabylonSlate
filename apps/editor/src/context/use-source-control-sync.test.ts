import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@haptic/core";
import type { HttpClient } from "@haptic/source-control";
import { SourceControlService } from "../services/source-control-service";
import { INTEGRATED_REPOSITORY, integratedSync } from "../testing/integrated-sync";
import { signedInHosts } from "../testing/source-control-hosts";
import { followCheckedOutBranch, syncLocksFor } from "./use-source-control-sync";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("locks on the checked-out branch", () => {
  it("lock and push checks name the branch the working copy has checked out, through a real Git LFS client", async () => {
    // GitHub's locking API, recording each request's ref (test mode would use a fake that ignores refs).
    const refs: Array<[string, string]> = [];
    const http: HttpClient = async (request) => {
      // Only the Git LFS lock requests; the sign-in check asks the host API who the token belongs to.
      if (!request.url.includes("/info/lfs/locks")) return { status: 200, bodyText: '{"login":"ada"}' };
      const body = JSON.parse(String(request.body ?? "{}")) as { path?: string; ref?: { name?: string } };
      const endpoint = request.url.endsWith("/verify") ? "verify" : request.url.endsWith("/unlock") ? "unlock" : "create";
      refs.push([endpoint, body.ref?.name ?? ""]);
      return endpoint !== "create"
        ? { status: 200, bodyText: '{"ours":[],"theirs":[]}' }
        : { status: 201, bodyText: JSON.stringify({ lock: { id: "1", path: body.path, locked_at: "", owner: { name: "ada" } } }) };
    };
    const locks = new SourceControlService();
    locks.pausePolling();
    cleanups.push(() => locks.dispose());
    await locks.configure({
      settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY, branch: "main", lockOnEdit: "always" },
      projectKey: "game",
      platform: "electron",
      testMode: false,
      hosts: await signedInHosts(http, { origin: "https://github.com", username: "x-access-token", token: "t", kind: "github" }),
    });
    const { service, storage } = await integratedSync({ locks: syncLocksFor(locks) });
    cleanups.push(() => service.dispose());
    cleanups.push(followCheckedOutBranch(service, locks));

    await service.createBranch("feature");
    await locks.onEdit("assets/Rock.texture.hasset");
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.commit({ rowIds: new Set(["assets/Rock.texture.hasset"]), message: "Rock", push: true });
    // Lock On Edit (Always), the push's lock check, then Release Locks After Push.
    expect(refs).toEqual([["create", "refs/heads/feature"], ["verify", "refs/heads/feature"], ["unlock", "refs/heads/feature"]]);
  });
});
