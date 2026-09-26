// Harvest pusher — "send it to my repo".
// Pushes a bundled pack to GitHub with the Git Data API: one commit, no
// local git needed. The token arrives per call and is never stored, never
// logged, and never written into the repo. New repos default to private.

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { unzipSync } from "fflate";
import { FETCH_LEDGER } from "./fetch.js";

export type PushTarget = {
  /** Personal access token. Per-call only — never stored, never logged. */
  token: string;
  owner: string;
  repo: string;
  branch?: string;
  createIfMissing?: boolean;
  /** Default true when creating. */
  private?: boolean;
  /** Path prefix inside the repo. Default "". */
  path?: string;
  message?: string;
};

export type PushResult = { repoUrl: string; commitSha: string; files: number };

const GH_API = "https://api.github.com";

function cleanTokenError(message: string, token: string): string {
  // Belt and braces: redact only plausible tokens (short test strings would
  // mangle ordinary words). No code path below interpolates the token into
  // a message — it only ever leaves in the Authorization header.
  return token && token.length >= 12 ? message.split(token).join("<redacted-token>") : message;
}

async function gh(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  // One retry on 403/409: right after repo creation GitHub's git backend can
  // still be initializing ("empty repo" races).
  let last: { status: number; body: unknown } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    last = await ghOnce(path, token, init);
    if (last.status !== 403 && last.status !== 409) return last;
  }
  return last as { status: number; body: unknown };
}

async function ghOnce(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${GH_API}${path}`, {
      ...init,
      headers: {
        "User-Agent": "harvest-mcp/0.2.0",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(cleanTokenError(`GitHub request failed: ${(e as Error).message}`, token));
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function ghError(action: string, status: number, body: unknown, token: string): Error {
  const msg = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : "";
  return new Error(cleanTokenError(`GitHub ${action} failed (HTTP ${status})${msg ? `: ${msg}` : ""}`, token));
}

async function collectFiles(bundlePath: string): Promise<Array<{ rel: string; data: Uint8Array }>> {
  const st = await fs.stat(bundlePath);
  const files: Array<{ rel: string; data: Uint8Array }> = [];
  if (st.isDirectory()) {
    const walk = async (dir: string, base: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name === FETCH_LEDGER) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full, base);
        else if (e.isFile()) files.push({ rel: relative(base, full).split("\\").join("/"), data: await fs.readFile(full) });
      }
    };
    await walk(bundlePath, bundlePath);
  } else {
    const raw = await fs.readFile(bundlePath);
    const entries = unzipSync(raw);
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/")) continue;
      files.push({ rel: name, data });
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return files;
}

type GitHubRepo = { default_branch?: string; html_url?: string };
type GitHubRef = { object?: { sha?: string } };
type GitHubCommit = { tree?: { sha?: string } };

/**
 * Push a bundled pack (directory or .harvest.zip) to GitHub in ONE commit.
 * Creates the repo as private when createIfMissing and the repo is absent.
 */
export async function pushPack(bundlePath: string, target: PushTarget, packName: string): Promise<PushResult> {
  const { token, owner, repo } = target;
  if (!token) throw new Error("pushPack requires a token (per-call; never stored)");
  if (!owner || !repo) throw new Error("pushPack requires owner and repo");

  // Validate the bundle before touching the network.
  const files = await collectFiles(bundlePath);
  if (!files.length) throw new Error("nothing to push: bundle is empty");

  // 1. Repo: use as-is, or create private when asked.
  let repoBody: GitHubRepo | null = null;
  let seeded = false; // true when we created the repo (auto_init README to remove)
  {
    const { status, body } = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
    if (status === 200) repoBody = body as GitHubRepo;
    else if (status === 404 && target.createIfMissing) {
      // auto_init: GitHub's git-data endpoints 409 on a truly empty repo, so
      // let GitHub make the seed commit; the pack commit below removes the
      // auto README again (sha: null) so the repo holds exactly the pack.
      const created = await gh("/user/repos", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: repo,
          private: target.private ?? true,
          description: `Harvest pack: ${packName}`,
          auto_init: true,
        }),
      });
      if (created.status !== 201) throw ghError("create repo", created.status, created.body, token);
      repoBody = created.body as GitHubRepo;
      seeded = true;
    } else if (status === 404) {
      throw new Error(`repo ${owner}/${repo} not found (and createIfMissing is off)`);
    } else {
      throw ghError("get repo", status, body, token);
    }
  }

  const branch = target.branch ?? repoBody?.default_branch ?? "main";
  const prefix = (target.path ?? "").replace(/^\/+|\/+$/g, "");

  // 2. Blobs, one per file.
  const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
  for (const f of files) {
    const { status, body } = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: Buffer.from(f.data).toString("base64"), encoding: "base64" }),
    });
    if (status !== 201) throw ghError("create blob", status, body, token);
    const sha = (body as { sha?: string }).sha;
    if (!sha) throw new Error("GitHub blob response missing sha");
    tree.push({ path: prefix ? `${prefix}/${f.rel}` : f.rel, mode: "100644", type: "blob", sha });
  }
  if (seeded) {
    // Remove the auto_init README so the repo holds exactly the pack.
    tree.push({ path: "README.md", mode: "100644", type: "blob", sha: null });
  }

  // 3. Base commit (absent on a brand-new repo).
  let parents: string[] = [];
  let baseTree: string | undefined;
  {
    const { status, body } = await gh(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
      token,
    );
    if (status === 200) {
      const sha = (body as GitHubRef).object?.sha;
      if (sha) {
        parents = [sha];
        const c = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`, token);
        if (c.status === 200) baseTree = (c.body as GitHubCommit).tree?.sha;
      }
    }
  }

  // 4. Tree + commit (single commit for the whole pack).
  const treeRes = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tree, ...(baseTree ? { base_tree: baseTree } : {}) }),
  });
  if (treeRes.status !== 201) throw ghError("create tree", treeRes.status, treeRes.body, token);
  const treeSha = (treeRes.body as { sha?: string }).sha;
  if (!treeSha) throw new Error("GitHub tree response missing sha");

  const message = target.message ?? `harvest: ${packName} (${files.length} files, sources in MANIFEST.json)`;
  const commitRes = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, tree: treeSha, parents }),
  });
  if (commitRes.status !== 201) throw ghError("create commit", commitRes.status, commitRes.body, token);
  const commitSha = (commitRes.body as { sha?: string }).sha;
  if (!commitSha) throw new Error("GitHub commit response missing sha");

  // 5. Point the branch at the new commit.
  const refPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`;
  if (parents.length) {
    const u = await gh(refPath, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commitSha }),
    });
    if (u.status !== 200) throw ghError("update ref", u.status, u.body, token);
  } else {
    const c = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
    });
    if (c.status !== 201) throw ghError("create ref", c.status, c.body, token);
  }

  return {
    repoUrl: repoBody?.html_url ?? `https://github.com/${owner}/${repo}`,
    commitSha,
    files: files.length,
  };
}

// TODO(GitLab): pushPack equivalent via the GitLab Commits API.
// Sketched seam — do not build in this WO:
//   POST /projects/:id/repository/commits with { branch, commit_message,
//     actions: [{ action: "create"|"update", file_path, content (base64),
//     encoding: "base64" }] } — one commit, same as the GitHub path above.
//   export async function pushPackGitLab(bundlePath: string, target: {
//     token: string; projectId: string | number; branch?: string;
//     path?: string; message?: string;
//   }, packName: string): Promise<PushResult>
