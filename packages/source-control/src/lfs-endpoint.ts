export function lfsRefName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function lfsLocksUrl(lfsBase: string): string {
  return `${lfsBase.replace(/\/+$/, "")}/locks`;
}

/**
 * Derive the Git LFS locking base (`…/.git/info/lfs`) from an explicitly
 * configured remote. SSH remotes use the HTTPS form of the same host because
 * a PAT is required regardless.
 */
export function lfsEndpointFromRepoUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const scp = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    return httpsLfsBase(scp[1]!, scp[2]!);
  }

  const ssh = trimmed.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/);
  if (ssh) {
    return httpsLfsBase(ssh[1]!, ssh[2]!);
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.pathname === "/" || url.pathname === "") return null;
    return httpsLfsBase(url.host, url.pathname);
  } catch {
    return null;
  }
}

function httpsLfsBase(host: string, path: string): string {
  let repoPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!repoPath) return `https://${host}/info/lfs`;
  if (!repoPath.endsWith(".git")) repoPath = `${repoPath}.git`;
  return `https://${host}/${repoPath}/info/lfs`;
}
