import type { SecretPort } from "./credentials";
import type { HttpClient, HttpRequest, HttpResponse } from "./http";

function json(status: number, body: unknown): HttpResponse {
  return { status, bodyText: JSON.stringify(body) };
}

/** Secrets held in memory: test mode keeps nothing on the device. */
export class MemorySecrets implements SecretPort {
  readonly values = new Map<string, string>();
  reads = 0;

  async get(key: string): Promise<string | null> {
    this.reads += 1;
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const DEVICE_CODE = "fake-device-code";

/**
 * GitHub and gitlab.com as Haptic calls them: device sign-in, the signed-in
 * user, repositories, branches and the remote tree. Test mode signs in
 * through it, and tests script its answers. Every other URL is a 404.
 */
export class FakeGitHost {
  readonly requests: HttpRequest[] = [];
  /** `error` answers for the next token polls, in order; once empty, the token is granted. */
  tokenReplies: string[] = ["authorization_pending"];
  account = "test-user";
  accountId = 1001;
  repositories = ["haptic-test/game", "haptic-test/prototype"];
  /** Repositories listed as Public; every other one is Private. */
  readonly publicRepositories = new Set<string>();
  /** The account's organizations (GitHub) or groups (GitLab). */
  organizations = ["haptic-studio"];
  /**
   * Listing organizations or groups answers 403, as GitHub does for an OAuth
   * token without the `read:org` or `user` scope (a sign-in from before
   * Haptic asked for `read:org`, or an organization that restricts OAuth apps).
   */
  organizationsRefused = false;
  /** The branches of every repository not in `repositoryBranches`. */
  branches = ["main", "develop"];
  /**
   * Branches by repository name. A repository created through the API has
   * none (it is empty until a push, which this host never sees: tests set
   * them as a push would).
   */
  readonly repositoryBranches = new Map<string, string[]>();
  /** Remote branch content: path → Git blob id, for every repository and branch. */
  readonly remoteBlobs = new Map<string, string>();
  /** Seconds between token polls the device code asks for. */
  interval = 0;
  /** Seconds a GitLab token lasts; GitLab grants come with a refresh token. */
  gitlabExpiresIn = 7200;
  /** Seconds a GitHub token lasts, as a GitHub App with expiring user tokens grants them; null as an OAuth App's never expire. */
  githubExpiresIn: number | null = null;
  /** Tokens the host now refuses with 401, as an expired or revoked token. */
  readonly refusedTokens = new Set<string>();
  /** GitLab refresh tokens still valid; each refresh spends its token and issues the next. */
  private readonly refreshTokens = new Set<string>();
  private issued = 0;

  readonly http: HttpClient = async (request) => {
    this.requests.push(request);
    return this.answer(request);
  };

  private answer(request: HttpRequest): HttpResponse {
    const url = new URL(request.url);
    const route = `${request.method} ${url.origin}${url.pathname}`;
    const bearer = request.headers.Authorization?.startsWith("Bearer fake-");
    switch (route) {
      case "POST https://github.com/login/device/code":
      case "POST https://gitlab.com/oauth/authorize_device":
        return json(200, { device_code: DEVICE_CODE, user_code: "WDJB-MJHT", verification_uri: "https://example.invalid/", expires_in: 900, interval: this.interval });
      case "POST https://github.com/login/oauth/access_token":
      case "POST https://gitlab.com/oauth/token": {
        const params = new URLSearchParams(typeof request.body === "string" ? request.body : "");
        if (params.get("grant_type") === "refresh_token") return this.refresh(params.get("refresh_token") ?? "");
        if (params.get("device_code") !== DEVICE_CODE) return json(400, { error: "incorrect_device_code" });
        const error = this.tokenReplies.shift();
        if (error) return json(url.hostname === "gitlab.com" ? 400 : 200, { error });
        return url.hostname === "gitlab.com"
          ? this.gitlabGrant("fake-gitlab-token")
          : json(200, {
            access_token: "fake-github-token",
            token_type: "bearer",
            ...(this.githubExpiresIn === null ? {} : { expires_in: this.githubExpiresIn, refresh_token: "fake-github-refresh" }),
          });
      }
    }
    const token = request.headers.Authorization?.replace(/^Bearer /, "") ?? "";
    if (!bearer || this.refusedTokens.has(token)) return json(401, { message: "Bad credentials" });
    if (route === "GET https://api.github.com/user") return json(200, { login: this.account, id: this.accountId });
    if (route === "GET https://gitlab.com/api/v4/user") return json(200, { username: this.account, id: this.accountId });
    const page = Number(url.searchParams.get("page") ?? "1");
    const firstPage = <T>(items: T[]) => json(200, page === 1 ? items : []);
    const github = (name: string) => ({ full_name: name, default_branch: "main", private: !this.publicRepositories.has(name), pushed_at: "2026-11-01T10:00:00Z" });
    const gitlab = (name: string) => ({ path_with_namespace: name, default_branch: "main", visibility: this.publicRepositories.has(name) ? "public" : "private", last_activity_at: "2026-11-01T10:00:00Z" });
    if (route === "GET https://api.github.com/user/repos") return firstPage(this.repositories.map(github));
    if (route === "GET https://gitlab.com/api/v4/projects") return firstPage(this.repositories.map(gitlab));
    if (this.organizationsRefused && (route === "GET https://api.github.com/user/orgs" || route === "GET https://gitlab.com/api/v4/groups")) {
      return json(403, { message: "You need at least read:org scope or user scope to list your organizations." });
    }
    if (route === "GET https://api.github.com/user/orgs") return firstPage(this.organizations.map((login) => ({ login })));
    if (route === "GET https://gitlab.com/api/v4/groups") {
      return firstPage(this.organizations.map((path, index) => ({ full_path: path, id: index + 100 })));
    }
    const gitHubCreate = /^POST https:\/\/api\.github\.com\/(?:user|orgs\/([^/]+))\/repos$/.exec(route);
    if (gitHubCreate || route === "POST https://gitlab.com/api/v4/projects") {
      const body = JSON.parse(typeof request.body === "string" ? request.body : "{}") as { name?: string; private?: boolean; visibility?: string; namespace_id?: string };
      const namespace = gitHubCreate
        ? (gitHubCreate[1] ? decodeURIComponent(gitHubCreate[1]) : this.account)
        : body.namespace_id ? this.organizations[Number(body.namespace_id) - 100] : this.account;
      const name = `${namespace}/${body.name ?? ""}`;
      if (!body.name || !namespace) return json(422, { message: "Repository creation failed." });
      if (this.repositories.includes(name)) {
        // As each host refuses a taken name.
        return gitHubCreate
          ? json(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] })
          : json(400, { message: { name: ["has already been taken"], path: ["has already been taken"] } });
      }
      this.repositories.unshift(name);
      this.repositoryBranches.set(name, []);
      if (body.private === false || body.visibility === "public") this.publicRepositories.add(name);
      return json(201, gitHubCreate ? github(name) : gitlab(name));
    }
    const repository = /^GET https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(\/branches)?$/.exec(route)
      ?? /^GET https:\/\/gitlab\.com\/api\/v4\/projects\/([^/]+)(\/repository\/branches)?$/.exec(route);
    if (repository) {
      const name = decodeURIComponent(repository[1]!);
      if (repository[2]) return firstPage((this.repositoryBranches.get(name) ?? this.branches).map((branch) => ({ name: branch })));
      if (!this.repositories.includes(name)) return json(404, { message: "Not Found" });
      return json(200, route.includes("api.github.com") ? github(name) : gitlab(name));
    }
    const tree = [...this.remoteBlobs].map(([path, id]) => ({ path, type: "blob", sha: id, id }));
    if (/^GET https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/.test(route)) return json(200, { tree, truncated: false });
    if (/^GET https:\/\/gitlab\.com\/api\/v4\/projects\/[^/]+\/repository\/tree$/.test(route)) {
      // One folder's entries, as GitLab lists them without `recursive`.
      const folder = url.searchParams.get("path") ?? "";
      const listing = tree.filter((entry) => entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === folder);
      if (folder && listing.length === 0) return json(404, { message: "404 Tree Not Found" });
      const size = Number(url.searchParams.get("per_page") ?? "20");
      return json(200, listing.slice((page - 1) * size, page * size));
    }
    return json(404, { message: "Not Found" });
  }

  private gitlabGrant(token: string): HttpResponse {
    this.issued += 1;
    const refreshToken = `fake-gitlab-refresh-${this.issued}`;
    this.refreshTokens.add(refreshToken);
    return json(200, { access_token: token, token_type: "Bearer", refresh_token: refreshToken, expires_in: this.gitlabExpiresIn });
  }

  private refresh(refreshToken: string): HttpResponse {
    if (!this.refreshTokens.delete(refreshToken)) return json(400, { error: "invalid_grant" });
    return this.gitlabGrant(`fake-gitlab-token-${this.issued + 1}`);
  }
}
