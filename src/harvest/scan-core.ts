import { EXPERTS, EXPERT_BY_ID, expertForTags } from "../experts.js";
import type { ExpertId, HarvestItem, ScanOrigin } from "../types.js";
import { defaultScanEnv, ghUrl, hfUrl, type ScanEnv } from "./net.js";

type CacheEntry = { at: number; data: HarvestItem[] };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 12 * 60 * 1000;

function fromCache(key: string): HarvestItem[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function toCache(key: string, data: HarvestItem[]) {
  cache.set(key, { at: Date.now(), data });
  return data;
}

export type Tokens = { hf?: string; gh?: string };

type HfRaw = {
  id?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  gated?: boolean | string;
  tags?: string[];
  description?: string;
  cardData?: { license?: string; pretty_name?: string };
};

type GhRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  pushed_at: string;
  topics?: string[];
  license?: { spdx_id?: string } | null;
  owner?: { login: string };
  name: string;
};

function splitId(id: string): { owner: string; name: string } {
  const i = id.indexOf("/");
  if (i <= 0) return { owner: "", name: id };
  return { owner: id.slice(0, i), name: id.slice(i + 1) };
}

function mapHf(raw: HfRaw, expert: ExpertId, origin: ScanOrigin): HarvestItem | null {
  const id = raw.id;
  if (!id) return null;
  const { owner, name } = splitId(id);
  const tags = raw.tags ?? [];
  return {
    id,
    source: "huggingface",
    kind: "dataset",
    name,
    owner: owner || raw.author || "",
    url: `https://huggingface.co/datasets/${id}`,
    description: raw.description || raw.cardData?.pretty_name || "",
    expert: expertForTags(`${id} ${raw.description ?? ""}`, tags, expert),
    tags: tags.slice(0, 8).map((t) => t.replace(/^.*:/, "")),
    license: raw.cardData?.license ?? null,
    downloads: raw.downloads ?? null,
    likes: raw.likes ?? null,
    stars: null,
    language: tags.find((t) => t.startsWith("language:"))?.slice(9) ?? null,
    lastModified: raw.lastModified ?? null,
    gated: Boolean(raw.gated),
    origin,
  };
}

function mapGh(raw: GhRepo, expert: ExpertId, origin: ScanOrigin): HarvestItem {
  const tags = raw.topics ?? [];
  return {
    id: raw.full_name,
    source: "github",
    kind: "repo",
    name: raw.name,
    owner: raw.owner?.login || raw.full_name.split("/")[0] || "",
    url: raw.html_url,
    description: raw.description || "",
    expert: expertForTags(`${raw.full_name} ${raw.description ?? ""}`, tags, expert),
    tags,
    license: raw.license?.spdx_id ?? null,
    downloads: null,
    likes: null,
    stars: raw.stargazers_count,
    language: raw.language,
    lastModified: raw.pushed_at,
    gated: false,
    origin,
  };
}

async function hfDatasets(
  env: ScanEnv,
  params: Record<string, string>,
  tokens: Tokens,
  expert: ExpertId,
  origin: ScanOrigin,
): Promise<HarvestItem[]> {
  const url = hfUrl(env, "/api/datasets", {
    limit: params.limit ?? "12",
    ...params,
  });
  const headers: Record<string, string> = { Accept: "application/json" };
  if (tokens.hf) headers.Authorization = `Bearer ${tokens.hf}`;
  if (env.userAgent) headers["User-Agent"] = env.userAgent;
  const res = await env.fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`Hugging Face ${res.status}`);
  const body = (await res.json()) as HfRaw[];
  return body.map((r) => mapHf(r, expert, origin)).filter((x): x is HarvestItem => !!x);
}

async function ghSearch(
  env: ScanEnv,
  q: string,
  tokens: Tokens,
  expert: ExpertId,
  origin: ScanOrigin,
  sort: "stars" | "updated" = "stars",
): Promise<HarvestItem[]> {
  const url = ghUrl(env, "/search/repositories", {
    q,
    sort,
    order: "desc",
    per_page: "10",
  });
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.userAgent) headers["User-Agent"] = env.userAgent;
  if (tokens.gh) headers.Authorization = `Bearer ${tokens.gh}`;
  const res = await env.fetch(url.toString(), { headers });
  if (res.status === 403) throw new Error("GitHub rate limit — set GITHUB_TOKEN (or pass gh_token).");
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const body = (await res.json()) as { items?: GhRepo[] };
  return (body.items ?? []).map((r) => mapGh(r, expert, origin));
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = items[i++];
      out.push(await fn(cur));
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

export type ScanResult = {
  ok: true;
  items: HarvestItem[];
  cached?: boolean;
  errors?: string[];
};

export async function scanExpertCore(
  expert: ExpertId,
  tokens: Tokens = {},
  env: ScanEnv = defaultScanEnv(),
): Promise<ScanResult> {
  const key = `expert:${expert}:${Boolean(tokens.hf)}:${Boolean(tokens.gh)}`;
  const cached = fromCache(key);
  if (cached) return { ok: true, items: cached, cached: true };
  const def = EXPERT_BY_ID[expert];
  const hfQ = def.hfQueries[0] ?? def.short;
  const ghQ = def.ghQueries[0] ?? `${def.short} stars:>200`;
  const hfParams: Record<string, string> = {
    search: hfQ,
    sort: "downloads",
    direction: "-1",
    limit: "12",
  };
  if (def.hfFilters[0]) hfParams.filter = def.hfFilters[0];
  const [hf, gh] = await Promise.allSettled([
    hfDatasets(env, hfParams, tokens, expert, "live"),
    ghSearch(env, ghQ, tokens, expert, "live"),
  ]);
  const items: HarvestItem[] = [];
  if (hf.status === "fulfilled") items.push(...hf.value);
  if (gh.status === "fulfilled") items.push(...gh.value);
  const errors = [
    hf.status === "rejected" ? String((hf.reason as Error)?.message ?? hf.reason) : null,
    gh.status === "rejected" ? String((gh.reason as Error)?.message ?? gh.reason) : null,
  ].filter((x): x is string => !!x);
  toCache(key, items);
  return { ok: true, items, cached: false, errors };
}

export async function sweepAtlasCore(
  tokens: Tokens = {},
  env: ScanEnv = defaultScanEnv(),
): Promise<ScanResult> {
  const key = `sweep:${Boolean(tokens.hf)}:${Boolean(tokens.gh)}`;
  const cached = fromCache(key);
  if (cached) return { ok: true, items: cached, cached: true };
  const chunks = await pool(EXPERTS, 3, async (ex) => {
    const hfParams: Record<string, string> = {
      search: ex.hfQueries[0] ?? ex.short,
      sort: "downloads",
      direction: "-1",
      limit: "6",
    };
    if (ex.hfFilters[0]) hfParams.filter = ex.hfFilters[0];
    const [hf, gh] = await Promise.allSettled([
      hfDatasets(env, hfParams, tokens, ex.id, "live"),
      ghSearch(env, ex.ghQueries[0] ?? `${ex.short} stars:>300`, tokens, ex.id, "live"),
    ]);
    const items: HarvestItem[] = [];
    if (hf.status === "fulfilled") items.push(...hf.value.slice(0, 6));
    if (gh.status === "fulfilled") items.push(...gh.value.slice(0, 4));
    return items;
  });
  const items = chunks.flat();
  toCache(key, items);
  return { ok: true, items, cached: false };
}

export async function scanLatestCore(
  tokens: Tokens = {},
  env: ScanEnv = defaultScanEnv(),
): Promise<ScanResult> {
  const key = `latest:${Boolean(tokens.hf)}:${Boolean(tokens.gh)}`;
  const cached = fromCache(key);
  if (cached) return { ok: true, items: cached, cached: true };
  const monthAgo = new Date();
  monthAgo.setMonth(monthAgo.getMonth() - 2);
  const since = monthAgo.toISOString().slice(0, 10);
  const [hf, ghHot, ghLlm] = await Promise.allSettled([
    hfDatasets(env, { sort: "lastModified", direction: "-1", limit: "24" }, tokens, "language", "latest"),
    ghSearch(env, `stars:>4000 pushed:>${since}`, tokens, "systems", "latest", "updated"),
    ghSearch(env, `topic:llm stars:>800 pushed:>${since}`, tokens, "code", "latest", "updated"),
  ]);
  const items: HarvestItem[] = [];
  if (hf.status === "fulfilled") items.push(...hf.value);
  if (ghHot.status === "fulfilled") items.push(...ghHot.value);
  if (ghLlm.status === "fulfilled") items.push(...ghLlm.value);
  toCache(key, items);
  return { ok: true, items, cached: false };
}

export async function searchAllCore(
  qRaw: string,
  tokens: Tokens = {},
  env: ScanEnv = defaultScanEnv(),
): Promise<ScanResult> {
  const q = qRaw.trim();
  if (!q) return { ok: true, items: [] };
  const key = `q:${q}:${Boolean(tokens.hf)}:${Boolean(tokens.gh)}`;
  const cached = fromCache(key);
  if (cached) return { ok: true, items: cached, cached: true };
  const [hf, gh] = await Promise.allSettled([
    hfDatasets(
      env,
      { search: q, sort: "downloads", direction: "-1", limit: "16" },
      tokens,
      expertForTags(q, []),
      "search",
    ),
    ghSearch(env, `${q} stars:>50`, tokens, expertForTags(q, []), "search", "stars"),
  ]);
  const items: HarvestItem[] = [];
  if (hf.status === "fulfilled") items.push(...hf.value);
  if (gh.status === "fulfilled") items.push(...gh.value);
  const errors = [
    hf.status === "rejected" ? String((hf.reason as Error)?.message ?? hf.reason) : null,
    gh.status === "rejected" ? String((gh.reason as Error)?.message ?? gh.reason) : null,
  ].filter((x): x is string => !!x);
  toCache(key, items);
  return { ok: true, items, cached: false, errors };
}
