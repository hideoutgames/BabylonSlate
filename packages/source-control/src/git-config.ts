import type { GitConfigPrefill } from "./types";

export function parseGitConfigPrefill(
  configText: string,
  headText: string | null,
): GitConfigPrefill {
  const repositoryUrl = remoteOriginUrl(configText);
  const fromHead = branchFromHead(headText);
  const branch = fromHead || firstBranchMerge(configText);
  return { repositoryUrl, branch };
}

function remoteOriginUrl(configText: string): string {
  const origin = sectionBody(configText, 'remote "origin"');
  if (!origin) return "";
  const match = origin.match(/^\s*url\s*=\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

function firstBranchMerge(configText: string): string {
  const match = configText.match(/\[branch\s+"[^"]+"\][^\[]*?merge\s*=\s*refs\/heads\/(\S+)/);
  return match?.[1]?.trim() ?? "";
}

function branchFromHead(headText: string | null): string {
  if (!headText) return "";
  const match = headText.trim().match(/^ref:\s*refs\/heads\/(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

function sectionBody(configText: string, header: string): string | null {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = configText.match(
    new RegExp(`\\[${escaped}\\]([^\\[]*)`, "m"),
  );
  return match?.[1] ?? null;
}
