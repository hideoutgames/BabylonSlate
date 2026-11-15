export function lfsRefName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function lfsLocksUrl(lfsBase: string): string {
  return `${lfsBase.replace(/\/+$/, "")}/locks`;
}

/** An explicitly configured remote as its HTTPS origin and repository path (no `.git`). */
export interface RepositoryLocation {
  origin: string;
  /** `owner/name`, or a GitLab group path; never empty, never ending in `.git`. */
  path: string;
}

/**
 * Parse a configured remote. SSH remotes map to the HTTPS form of the same
 * host because a token is required regardless; an `ssh://` user and port do
 * not apply to the HTTPS host, so they are dropped, as git-lfs does. A plain
 * `http://` remote is upgraded, so a token never travels over plain HTTP.
 */
export function parseRepositoryUrl(raw: string): RepositoryLocation | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const scp = trimmed.match(/^git@([^:/]+):(.+)$/);
  if (scp) return location(scp[1]!, scp[2]!);
  try {
    const url = new URL(trimmed);
    if (/^ssh:$/i.test(url.protocol)) return location(url.hostname, url.pathname);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return location(url.host, url.pathname);
  } catch {
    return null;
  }
}

function location(host: string, rawPath: string): RepositoryLocation | null {
  if (!host) return null;
  const path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path) return null;
  try {
    return { origin: new URL(`https://${host}`).origin, path };
  } catch {
    return null;
  }
}

/** The HTTPS clone URL of a repository location. */
export function repositoryCloneUrl({ origin, path }: RepositoryLocation): string {
  return `${origin}/${path}.git`;
}

/** The Git LFS locking base (`…/<path>.git/info/lfs`) of a configured remote. */
export function lfsEndpointFromRepoUrl(raw: string): string | null {
  const parsed = parseRepositoryUrl(raw);
  return parsed ? `${repositoryCloneUrl(parsed)}/info/lfs` : null;
}

/** The HTTPS origin a typed host or repository URL names (a plain `http://` one is upgraded), or null. */
export function hostOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname ? new URL(`https://${url.host}`).origin : null;
  } catch {
    return null;
  }
}
