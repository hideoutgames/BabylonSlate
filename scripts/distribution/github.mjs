export function githubClient({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token) throw new Error("GitHub repository and token are required");
  return async function api(path, { optional = false, method = "GET", body, bytes, contentType } = {}) {
    const url = path.startsWith("https://uploads.github.com/") ? path : `https://api.github.com/repos/${repository}${path}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}), ...(contentType ? { "Content-Type": contentType } : {}) },
      body: bytes ?? (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(120000),
      redirect: "error",
    });
    if (optional && response.status === 404) return null;
    // Do not echo GitHub response bodies, inputs or authorization headers.
    if (!response.ok) throw new Error(`GitHub ${method} request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
}
