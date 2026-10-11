import type { GitConfigPrefill } from "./types";

export function parseGitConfigPrefill(
  configText: string,
  headText: string | null,
): GitConfigPrefill {
  const repositoryUrl = remoteOriginUrl(configText);
  // A detached HEAD names no branch; any configured branch would be a guess.
  const branch = headText === null ? firstBranchMerge(configText) : branchFromHead(headText);
  return { repositoryUrl, branch };
}

function remoteOriginUrl(configText: string): string {
  const origin = sectionBody(configText, 'remote "origin"');
  if (!origin) return "";
  const match = origin.match(/^\s*url\s*=(.*)$/m);
  return match ? configValue(match[1]!) : "";
}

function firstBranchMerge(configText: string): string {
  const match = configText.match(/\[branch\s+"[^"]+"\][^[]*?merge\s*=(.*)/);
  const ref = match ? configValue(match[1]!) : "";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
}

function branchFromHead(headText: string): string {
  const match = headText.trim().match(/^ref:\s*refs\/heads\/(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

/**
 * Git config value syntax: double quotes group text (keeping `;` and `#`),
 * backslashes escape, and an unquoted `;` or `#` starts a comment.
 */
function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      const next = raw[++index]!;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === ";" || char === "#")) {
      break;
    } else {
      value += char;
    }
  }
  return value.trim();
}

function sectionBody(configText: string, header: string): string | null {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = configText.match(
    new RegExp(`\\[${escaped}\\]([^\\[]*)`, "m"),
  );
  return match?.[1] ?? null;
}
