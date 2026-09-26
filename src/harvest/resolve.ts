// Harvest "which files are usable" intelligence.
// Pure classification functions + thin API clients. No downloading here —
// the fetcher (fetch.ts) does that. No tokens required for public items.

export type PullKind = "data" | "weights" | "config" | "code" | "docs";

export type PullFile = {
  path: string;
  url: string;
  kind: PullKind;
  bytes: number | null;
  reason: string;
};

export type ResolvedPull = {
  pull: PullFile[];
  skipped: number;
  needs_token: boolean;
};

export type PackItemLike = {
  id: string;
  source: "huggingface" | "github";
  kind: "dataset" | "repo";
  url: string;
  ingest: { type: "hf-dataset" | "github-repo"; ref: string };
};

export type ResolveOpts = {
  hfToken?: string;
  ghToken?: string;
  userAgent?: string;
};

type Classified = { kind: PullKind | "skip"; reason: string };

const DATA_EXT = new Set(["parquet", "jsonl", "csv", "tsv", "arrow", "ndjson", "feather"]);
const WEIGHTS_EXT = new Set(["safetensors", "bin", "gguf", "onnx", "pt", "pth", "ckpt", "h5", "weights", "sft"]);
const CONFIG_NAMES = new Set([
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "generation_config.json",
  "special_tokens_map.json",
  "preprocessor_config.json",
  "feature_extractor_config.json",
  "chat_template.jinja",
  "readme.md",
]);

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "pyi", "go", "rs", "java", "kt", "kts", "scala",
  "c", "h", "cc", "cpp", "hpp", "cxx", "cs",
  "rb", "php", "swift", "lua", "pl", "pm", "r", "jl",
  "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql",
  "vue", "svelte", "astro",
]);
const REPO_CONFIG_NAMES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "pyproject.toml",
  "setup.py", "setup.cfg", "requirements.txt", "requirements-dev.txt",
  "cargo.toml", "go.mod", "go.sum", "gemfile", "composer.json",
  "dockerfile", "makefile", "cmakelists.txt", "build.gradle",
  ".env.example", ".editorconfig", ".nvmrc", ".python-version",
]);
const REPO_CONFIG_EXT = new Set(["yaml", "yml", "toml", "ini", "cfg", "conf", "jsonc"]);
const DOC_EXT = new Set(["md", "markdown", "rst", "txt", "adoc"]);
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "a", "o", "obj", "class",
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  "pdf", "mp4", "mp3", "wav", "ogg", "mov", "avi",
  "db", "sqlite", "sqlite3",
]);
const LOCKFILE_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "cargo.lock", "poetry.lock", "pdm.lock", "gemfile.lock", "composer.lock",
  "go.sum",
]);
const SKIP_DIRS = [".github/", ".git/", "node_modules/", "dist/", "build/", "out/", "target/", "vendor/", "__pycache__/", ".venv/", "venv/", ".next/", ".nuxt/", "coverage/"];

/** Max single file we'll put on a pull list (25 MB). Binaries and giants get skipped with a reason. */
export const MAX_PULL_FILE_BYTES = 25 * 1024 * 1024;

function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function baseOf(path: string): string {
  return (path.split("/").pop() ?? path).toLowerCase();
}

/** Classify one HuggingFace hub file. Pure. */
export function classifyHfFile(rfilename: string): Classified {
  const base = baseOf(rfilename);
  const ext = extOf(rfilename);
  if (base === ".gitattributes") return { kind: "skip", reason: "repo metadata, not usable content" };
  if (CONFIG_NAMES.has(base)) return { kind: "config", reason: "hub config/README file" };
  if (WEIGHTS_EXT.has(ext)) return { kind: "weights", reason: `model weights (.${ext})` };
  if (DATA_EXT.has(ext)) return { kind: "data", reason: `dataset shard (.${ext})` };
  return { kind: "skip", reason: `not a usable data/weights/config file (.${ext || "noext"})` };
}

/** Classify one GitHub tree entry. Pure. */
export function classifyGhFile(path: string, size: number | null): Classified {
  const lower = path.toLowerCase();
  for (const dir of SKIP_DIRS) {
    if (lower.startsWith(dir)) return { kind: "skip", reason: `vendored/build dir (${dir})` };
  }
  const base = baseOf(path);
  if (LOCKFILE_NAMES.has(base)) return { kind: "skip", reason: "lockfile — reproducible from manifest" };
  if (size != null && size > MAX_PULL_FILE_BYTES) {
    return { kind: "skip", reason: `over size cap (${(size / 1048576).toFixed(1)} MB)` };
  }
  const ext = extOf(path);
  if (BINARY_EXT.has(ext)) return { kind: "skip", reason: `binary asset (.${ext})` };
  if (REPO_CONFIG_NAMES.has(base)) return { kind: "config", reason: "project manifest/config" };
  if (base === "license" || base.startsWith("license.")) return { kind: "docs", reason: "license text" };
  if (CODE_EXT.has(ext)) return { kind: "code", reason: `source file (.${ext})` };
  if (REPO_CONFIG_EXT.has(ext)) return { kind: "config", reason: `config file (.${ext})` };
  if (DOC_EXT.has(ext)) return { kind: "docs", reason: `docs (.${ext})` };
  return { kind: "skip", reason: `unrecognized file type (.${ext || "noext"})` };
}

function encodePath(p: string): string {
  return p.split("/").map((s) => encodeURIComponent(s)).join("/");
}

function headers(opts: ResolveOpts, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": opts.userAgent ?? "harvest-mcp/0.2.0",
    Accept: "application/json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function getJson(url: string, opts: ResolveOpts, token?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    headers: headers(opts, token),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

type HfSibling = { rfilename: string; size?: number };
type HfApiBody = { siblings?: HfSibling[]; gated?: boolean | string; error?: string };

async function resolveHf(item: PackItemLike, opts: ResolveOpts): Promise<ResolvedPull> {
  // HarvestItem.kind is "dataset" for every HuggingFace item (models included),
  // so probe both hub endpoints and take whichever answers.
  let gated = false;
  for (const apiPath of ["datasets", "models"] as const) {
    const apiUrl = `https://huggingface.co/api/${apiPath}/${encodePath(item.id)}`;
    const { status, body } = await getJson(apiUrl, opts, opts.hfToken);
    if (status === 401 || status === 403) {
      gated = true;
      continue;
    }
    if (status === 404) continue;
    if (status !== 200 || !body || typeof body !== "object") {
      throw new Error(`HF API ${apiPath}/${item.id} returned status ${status}`);
    }
    const siblings = ((body as HfApiBody).siblings ?? []).filter((s) => typeof s?.rfilename === "string");
    const pull: PullFile[] = [];
    let skipped = 0;
    for (const s of siblings) {
      const c = classifyHfFile(s.rfilename);
      if (c.kind === "skip") {
        skipped++;
        continue;
      }
      pull.push({
        path: s.rfilename,
        url: `https://huggingface.co/${apiPath}/${encodePath(item.id)}/resolve/main/${encodePath(s.rfilename)}`,
        kind: c.kind,
        bytes: typeof s.size === "number" ? s.size : null,
        reason: c.reason,
      });
    }
    return { pull, skipped, needs_token: false };
  }
  if (gated) return { pull: [], skipped: 0, needs_token: true };
  throw new Error(`HF ${item.id} not found as a dataset or model (404)`);
}

type GhTreeEntry = { path?: string; type?: string; size?: number };
type GhTreeBody = { tree?: GhTreeEntry[]; message?: string };

async function resolveGh(item: PackItemLike, opts: ResolveOpts): Promise<ResolvedPull> {
  const [owner, repo] = item.id.split("/");
  if (!owner || !repo) throw new Error(`cannot parse owner/repo from "${item.id}"`);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/HEAD?recursive=1`;
  const { status, body } = await getJson(apiUrl, opts, opts.ghToken);
  if (status === 401 || status === 403 || status === 404) {
    // 404 on this endpoint also means "private repo you can't see".
    return { pull: [], skipped: 0, needs_token: true };
  }
  if (status !== 200 || !body || typeof body !== "object" || !Array.isArray((body as GhTreeBody).tree)) {
    throw new Error(`GitHub tree API for ${item.id} returned status ${status}`);
  }
  const pull: PullFile[] = [];
  let skipped = 0;
  for (const e of (body as GhTreeBody).tree ?? []) {
    if (e?.type !== "blob" || typeof e.path !== "string") {
      skipped++;
      continue;
    }
    const c = classifyGhFile(e.path, typeof e.size === "number" ? e.size : null);
    if (c.kind === "skip") {
      skipped++;
      continue;
    }
    pull.push({
      path: e.path,
      url: `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${encodePath(e.path)}`,
      kind: c.kind,
      bytes: typeof e.size === "number" ? e.size : null,
      reason: c.reason,
    });
  }
  return { pull, skipped, needs_token: false };
}

/**
 * Resolve one pack item to a pull list: the files a human would actually
 * want, each with a one-line reason. No downloading, no tokens required
 * for public items. Gated/private items come back with needs_token: true.
 */
export async function resolveItem(item: PackItemLike, opts: ResolveOpts = {}): Promise<ResolvedPull> {
  if (item.source === "huggingface") return resolveHf(item, opts);
  if (item.source === "github") return resolveGh(item, opts);
  throw new Error(`unknown source "${(item as { source: string }).source}"`);
}
