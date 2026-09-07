import { setTimeout as delay } from "node:timers/promises";
import { APPLE_BUNDLE_ID, appleAvailability } from "./apple-contract.mjs";
import { identityNotes } from "./publish.mjs";

export function validatePrivateGroups(groups, ids) {
  for (const group of groups) {
    if (group.attributes.publicLinkEnabled === true || group.attributes.hasAccessToAllBuilds === true) throw new Error("TestFlight groups must disable public links and automatic access to all builds");
  }
  for (const [channel, name] of [["test", "Test Builds"], ["release", "Release Candidates"]]) {
    const group = groups.find(item => item.id === ids[channel]);
    if (!group || group.attributes.name !== name) throw new Error("Expected private TestFlight group is missing or belongs to another app");
  }
}

export async function allApplePages(api, path) {
  const data = [];
  let next = path;
  let count = 0;
  while (next) {
    if (++count > 500) throw new Error("Apple pagination exceeded the audited limit");
    const result = await api(next);
    data.push(...result.data);
    next = result.links?.next;
  }
  return data;
}

export async function finalizeTestFlight({ identity, appId, group, timeoutMs = 20 * 60 * 1000 }, { api, now = Date.now, sleep = delay }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30 * 60 * 1000) throw new Error("Invalid TestFlight processing deadline");
  const app = await api(`/v1/apps/${appId}`);
  if (app?.data?.attributes?.bundleId !== APPLE_BUNDLE_ID) throw new Error("App Store Connect app record differs");
  const deadline = now() + timeoutMs;
  let state = "uploaded";
  do {
    const query = new URLSearchParams({ "filter[app]": appId, "filter[version]": identity.appleBuildNumber, include: "preReleaseVersion,buildBetaDetail", limit: "200" });
    const result = await api(`/v1/builds?${query}`);
    const builds = result.data.filter(build => build.attributes.version === identity.appleBuildNumber && result.included?.some(version => version.type === "preReleaseVersions" && version.id === build.relationships.preReleaseVersion.data.id && version.attributes.version === identity.appleMarketingVersion && version.attributes.platform === "IOS"));
    if (builds.length > 1) throw new Error("Apple returned ambiguous version/build identity");
    const build = builds[0];
    if (build) {
      const detail = result.included?.find(item => item.type === "buildBetaDetails" && item.id === build.relationships.buildBetaDetail?.data?.id);
      const betaState = detail?.attributes[group.attributes.isInternalGroup ? "internalBuildState" : "externalBuildState"];
      state = appleAvailability(build.attributes.processingState, betaState, false);
      if (state === "failed" || build.attributes.expired === true) return { state: "failed", buildNumber: identity.appleBuildNumber };
      if (build.attributes.processingState === "VALID" && state !== "processing") {
        const localizations = await allApplePages(api, `/v1/buildBetaLocalizations?filter[build]=${encodeURIComponent(build.id)}&limit=200`);
        const existing = localizations.find(item => item.attributes.locale === "en-US");
        if (existing?.attributes.whatsNew?.includes("Source:") && !existing.attributes.whatsNew.includes(`Source: ${identity.sourceSha}`)) throw new Error("Existing TestFlight source identity differs; do not relabel a binary");
        const whatsNew = `${identityNotes(identity)}\n\nExercise project creation, native storage and reopen, scene/graph editing, Play/Stop, audio and workers. ${identity.channel === "test" ? "Project policy: do not select this Indev build for the App Store." : "Release candidate for validation; no App Store submission is authorized."}`;
        if (existing) await api(`/v1/buildBetaLocalizations/${existing.id}`, { method: "PATCH", body: { data: { type: "buildBetaLocalizations", id: existing.id, attributes: { whatsNew } } } });
        else await api("/v1/buildBetaLocalizations", { method: "POST", body: { data: { type: "buildBetaLocalizations", attributes: { locale: "en-US", whatsNew }, relationships: { build: { data: { type: "builds", id: build.id } } } } } });
        const assignedGroups = await allApplePages(api, `/v1/builds/${build.id}/betaGroups?limit=200`);
        if (assignedGroups.some(item => item.id !== group.id)) throw new Error("Build is assigned to an unexpected TestFlight group; inspect group settings");
        if (!assignedGroups.some(item => item.id === group.id)) await api(`/v1/betaGroups/${group.id}/relationships/builds`, { method: "POST", body: { data: [{ type: "builds", id: build.id }] } });
        const membership = await allApplePages(api, `/v1/builds/${build.id}/betaGroups?limit=200`);
        const assigned = membership.some(item => item.id === group.id);
        state = appleAvailability(build.attributes.processingState, betaState, assigned);
        // External Beta App Review is explicitly reported, never App Store submission.
        // A maintainer supplies any review/contact/compliance details in App Store Connect.
        if (["available", "awaiting-beta-review"].includes(state)) return { state, buildNumber: identity.appleBuildNumber };
      }
    }
    if (now() >= deadline) break;
    await sleep(Math.min(30000, Math.max(1, deadline - now())));
  } while (now() <= deadline);
  return { state, buildNumber: identity.appleBuildNumber };
}
