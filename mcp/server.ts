#!/usr/bin/env node
/**
 * harvest-mcp — MCP server (stdio transport) for Harvest.
 *
 * Plain-English topic in -> 12 experts fan out over Hugging Face + GitHub ->
 * pack JSON out: coverage-scored training packs, or code build packs an agent
 * can pull and build from. No API keys required, no Bridge.
 *
 * Low-level @modelcontextprotocol/sdk Server API, hand-written JSON schemas,
 * no zod, no other dependencies.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  scanExpertCore,
  scanLatestCore,
  searchAllCore,
  sweepAtlasCore,
  type Tokens,
} from "../src/harvest/scan-core.js";
import { composeLocal, type SlimItem } from "../src/harvest/compose-local.js";
import { coverageOf, toCodePack, toPack } from "../src/coverage.js";
import { resolveItem } from "../src/harvest/resolve.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  fetchPullList,
  loadLedger,
  type FetchedFile,
} from "../src/harvest/fetch.js";
import { bundlePack } from "../src/harvest/bundle.js";
import { sanitizeId, type IndexedPack } from "../src/harvest/index.js";
import { pushPack } from "../src/harvest/push.js";
import type { ExpertId, HarvestItem } from "../src/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG_NAME = "harvest-mcp";
const PKG_VERSION = "0.2.2";

const EXPERT_IDS = [
  "code",
  "math",
  "science",
  "language",
  "vision",
  "audio",
  "medical",
  "law",
  "knowledge",
  "safety",
  "affect",
  "systems",
] as const;

type Args = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Tokens are optional everywhere: HF/GitHub public APIs work unauthenticated (rate-limited). */
function tokensFrom(args: Args): Tokens {
  return {
    hf: str(args.hf_token) ?? process.env.HF_TOKEN,
    gh: str(args.gh_token) ?? process.env.GITHUB_TOKEN,
  };
}

/** File kinds a resolve/pull can be restricted to (e.g. kinds: ["code","docs"] for a code build pack). */
const PULL_KINDS = ["data", "weights", "config", "code", "docs"] as const;

function kindsFrom(v: unknown): Set<string> | undefined {
  if (!Array.isArray(v)) return undefined;
  const s = new Set(
    v.filter(
      (x): x is string => typeof x === "string" && (PULL_KINDS as readonly string[]).includes(x),
    ),
  );
  return s.size > 0 ? s : undefined;
}

const KINDS_PROP = {
  kinds: {
    type: "array",
    items: { type: "string", enum: [...PULL_KINDS] },
    description:
      "Optional file-kind filter on the resolved pull list, e.g. [\"code\",\"docs\"] for a code build pack (skips weights/datasets). Omit for the full list.",
  },
};

const TOKEN_PROPS = {
  hf_token: {
    type: "string",
    description: "Optional Hugging Face token for higher rate limits. Falls back to the HF_TOKEN env var.",
  },
  gh_token: {
    type: "string",
    description: "Optional GitHub token for higher rate limits. Falls back to the GITHUB_TOKEN env var.",
  },
};

const CATALOG_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Item id, e.g. 'openai/gsm8k' or 'ggml-org/llama.cpp'." },
    source: { type: "string", enum: ["huggingface", "github"] },
    expert: { type: "string", enum: [...EXPERT_IDS] },
    description: { type: "string" },
  },
  required: ["id", "source", "expert"],
  additionalProperties: true,
};

const PACK_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Item id, e.g. 'openai/gsm8k' or 'The-Warl0ck/harvest-mcp'." },
    source: { type: "string", enum: ["huggingface", "github"] },
    kind: { type: "string", enum: ["dataset", "repo"] },
    url: { type: "string", description: "Canonical URL of the item." },
    ingest: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["hf-dataset", "github-repo"] },
        ref: { type: "string" },
      },
      additionalProperties: true,
    },
  },
  required: ["id", "source"],
  additionalProperties: true,
};

const TOOLS: Tool[] = [
  {
    name: "harvest.search",
    description:
      "Search Hugging Face datasets and GitHub repos for a plain-English topic, then sweep the 12-expert atlas for breadth. Returns deduplicated HarvestItem[]. Works with no tokens (public rate limits apply).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Plain-English topic, e.g. 'image classification' or 'speech recognition'.",
        },
        ...TOKEN_PROPS,
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "harvest.expert",
    description:
      "Run one of the 12 experts against Hugging Face + GitHub using its curated queries. Returns HarvestItem[].",
    inputSchema: {
      type: "object",
      properties: {
        expert: {
          type: "string",
          enum: [...EXPERT_IDS],
          description: "Expert id: code, math, science, language, vision, audio, medical, law, knowledge, safety, affect, systems.",
        },
        ...TOKEN_PROPS,
      },
      required: ["expert"],
      additionalProperties: false,
    },
  },
  {
    name: "harvest.latest",
    description:
      "Scan what's trending: recently-updated Hugging Face datasets and hot/recent GitHub repos. Returns HarvestItem[].",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPS },
      additionalProperties: false,
    },
  },
  {
    name: "harvest.compose",
    description:
      "Compose a balanced mix from a catalog of items with the local mixer — no LLM/mouth required. Returns picks with rationale.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What the training library is for, e.g. 'small vision-language model'.",
        },
        catalog: {
          type: "array",
          description: "Candidate items (e.g. from harvest.search).",
          items: CATALOG_ITEM_SCHEMA,
        },
      },
      required: ["goal", "catalog"],
      additionalProperties: false,
    },
  },
  {
    name: "harvest.pack",
    description:
      "Compose a mix from a catalog and emit a pack JSON. Purpose 'training' (default) emits a flare-harvest-library v1 pack with coverage scores for model training data. Purpose 'code' emits a flare-harvest-codepack v1: a parts bin an agent can pull (harvest.pull) and build from — no coverage scoring. No Bridge stanza included.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What the pack is for: a training goal ('small vision-language model') or a code build goal ('add rate-limiting to my API').",
        },
        name: {
          type: "string",
          description: "Pack name, e.g. 'Vision Mix v1'.",
        },
        purpose: {
          type: "string",
          enum: ["training", "code"],
          description: "Pack purpose. 'training' (default) scores the mix for training-data coverage; 'code' builds a code build pack an agent pulls and builds from.",
        },
        catalog: {
          type: "array",
          description: "Candidate items (e.g. from harvest.search). Full HarvestItem objects preferred.",
          items: CATALOG_ITEM_SCHEMA,
        },
      },
      required: ["goal", "catalog", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "harvest.resolve",
    description:
      "Preview what harvest.pull would download for one pack item: the pull list with a one-line reason per file (the loot preview). No downloading. Gated/private items return needs_token instead of failing. Pass kinds to preview only certain file kinds (e.g. [\"code\",\"docs\"]).",
    inputSchema: {
      type: "object",
      properties: {
        item: {
          ...PACK_ITEM_SCHEMA,
          description: "One pack item (e.g. from a harvest.pack items array).",
        },
        ...KINDS_PROP,
        ...TOKEN_PROPS,
      },
      required: ["item"],
      additionalProperties: false,
    },
  },
  {
    name: "harvest.pull",
    description:
      "Pull a pack's items to disk: resolve + fetch + index update, with an optional zip bundle. destination 'local' keeps files on disk; 'download' also builds a .harvest.zip. Pass kinds (e.g. [\"code\",\"docs\"]) to pull only certain file kinds — the code-pack flow. Oversized pulls return needs_confirm instead of downloading blind — pass confirm_large: true to proceed.",
    inputSchema: {
      type: "object",
      properties: {
        pack: {
          type: "object",
          description: "A flare-harvest-library or flare-harvest-codepack pack JSON (e.g. from harvest.pack). Returned with an additive index stanza.",
          additionalProperties: true,
        },
        ...KINDS_PROP,
        destination: {
          type: "string",
          enum: ["local", "download"],
          description: "'local' keeps fetched files on disk; 'download' additionally builds a .harvest.zip bundle.",
        },
        dir: {
          type: "string",
          description: "Where to put pulled files. Defaults to a harvest-pulls dir under the OS temp dir.",
        },
        confirm_large: {
          type: "boolean",
          description: "Set true after reviewing a needs_confirm response to proceed with an oversized pull.",
        },
        ...TOKEN_PROPS,
      },
      required: ["pack"],
      additionalProperties: false,
    },
  },
  {
    name: "harvest.push",
    description:
      "Push a pulled bundle (a .harvest.zip or a fetched directory) to the user's GitHub repo in one commit. The token is per-call only — never stored, never logged. New repos are created private by default.",
    inputSchema: {
      type: "object",
      properties: {
        bundle: {
          type: "string",
          description: "Absolute path to a .harvest.zip (from harvest.pull) or a fetched files directory.",
        },
        pack_name: {
          type: "string",
          description: "Pack name for the commit message, e.g. 'Vision Mix v1'.",
        },
        owner: { type: "string", description: "GitHub owner (user or org)." },
        repo: { type: "string", description: "GitHub repo name." },
        token: {
          type: "string",
          description: "GitHub personal access token, per call. Falls back to the GITHUB_TOKEN env var. Never stored.",
        },
        create_if_missing: {
          type: "boolean",
          description: "Create the repo if it doesn't exist (private by default).",
        },
        branch: { type: "string", description: "Branch to push to. Defaults to the repo's default branch." },
        path: { type: "string", description: "Path prefix inside the repo. Defaults to the repo root." },
      },
      required: ["bundle", "owner", "repo"],
      additionalProperties: false,
    },
  },
];

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function dedupe(items: HarvestItem[]): HarvestItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

function asCatalog(raw: unknown): SlimItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is SlimItem =>
        !!c &&
        typeof c.id === "string" &&
        typeof c.source === "string" &&
        typeof c.expert === "string",
    )
    .map((c) => ({ id: c.id, source: c.source, expert: c.expert as ExpertId, description: c.description }));
}

function asItems(raw: unknown): HarvestItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is HarvestItem =>
      !!c &&
      typeof c.id === "string" &&
      typeof c.source === "string" &&
      typeof c.url === "string",
  );
}

async function handleCall(name: string, args: Args) {
  switch (name) {
    case "harvest.search": {
      const topic = str(args.topic);
      if (!topic) return errorResult("harvest.search requires a non-empty 'topic' string.");
      const tokens = tokensFrom(args);
      const [searched, sweep] = await Promise.all([
        searchAllCore(topic, tokens),
        sweepAtlasCore(tokens),
      ]);
      return textResult({
        topic,
        items: dedupe([...searched.items, ...sweep.items]),
        searched: { cached: searched.cached ?? false, count: searched.items.length, errors: searched.errors ?? [] },
        sweep: { cached: sweep.cached ?? false, count: sweep.items.length },
      });
    }
    case "harvest.expert": {
      const expert = str(args.expert);
      if (!expert || !(EXPERT_IDS as readonly string[]).includes(expert)) {
        return errorResult(`harvest.expert requires 'expert' to be one of: ${EXPERT_IDS.join(", ")}.`);
      }
      const res = await scanExpertCore(expert as ExpertId, tokensFrom(args));
      return textResult(res);
    }
    case "harvest.latest": {
      const res = await scanLatestCore(tokensFrom(args));
      return textResult(res);
    }
    case "harvest.compose": {
      const goal = str(args.goal);
      const catalog = asCatalog(args.catalog);
      if (!goal) return errorResult("harvest.compose requires a non-empty 'goal' string.");
      if (!catalog.length) return errorResult("harvest.compose requires a non-empty 'catalog' array.");
      return textResult(composeLocal(goal, catalog));
    }
    case "harvest.pack": {
      const goal = str(args.goal);
      const name = str(args.name);
      const catalog = asCatalog(args.catalog);
      if (!goal || !name) return errorResult("harvest.pack requires non-empty 'goal' and 'name' strings.");
      if (!catalog.length) return errorResult("harvest.pack requires a non-empty 'catalog' array.");
      const composed = composeLocal(goal, catalog);
      const full = asItems(args.catalog);
      const byId = new Map(full.map((i) => [i.id, i]));
      // Fall back to slim records for ids missing full item data.
      const items: HarvestItem[] = composed.picks.map((p) => {
        const hit = byId.get(p.id);
        if (hit) return hit;
        const slim = catalog.find((c) => c.id === p.id);
        return {
          id: p.id,
          source: (slim?.source === "github" ? "github" : "huggingface") as "huggingface" | "github",
          kind: (slim?.source === "github" ? "repo" : "dataset") as "dataset" | "repo",
          name: p.id.split("/").pop() ?? p.id,
          owner: p.id.split("/")[0] ?? "",
          url:
            slim?.source === "github"
              ? `https://github.com/${p.id}`
              : `https://huggingface.co/datasets/${p.id}`,
          description: slim?.description ?? "",
          expert: p.expert ?? "language",
          tags: [],
          license: null,
          downloads: null,
          likes: null,
          stars: null,
          language: null,
          lastModified: null,
          gated: false,
          origin: "compose",
        } satisfies HarvestItem;
      });
      const now = new Date().toISOString();
      const lib = { id: `pack-${Date.now()}`, name, goal, createdAt: now, updatedAt: now, itemIds: items.map((i) => i.id) };
      // Code purpose: a parts bin for an agent to build from — same item
      // envelope, no training-coverage scoring.
      if (str(args.purpose) === "code") return textResult(toCodePack(lib, items));
      const cov = coverageOf(items);
      return textResult(toPack(lib, items, cov));
    }
    case "harvest.resolve": {
      const raw = args.item as Record<string, unknown> | undefined;
      const id = str(raw?.id);
      const source = raw?.source === "github" ? "github" : raw?.source === "huggingface" ? "huggingface" : undefined;
      if (!id || !source) return errorResult("harvest.resolve requires 'item' with 'id' and 'source' (huggingface|github).");
      const kind = raw?.kind === "repo" ? "repo" : "dataset";
      const ingestRaw = raw?.ingest as Record<string, unknown> | undefined;
      const tokens = tokensFrom(args);
      const resolved = await resolveItem(
        {
          id,
          source,
          kind,
          url: str(raw?.url) ?? "",
          ingest: {
            type: source === "github" ? "github-repo" : "hf-dataset",
            ref: str(ingestRaw?.ref) ?? "main",
          },
        },
        { hfToken: tokens.hf, ghToken: tokens.gh },
      );
      const kinds = kindsFrom(args.kinds);
      if (kinds) resolved.pull = resolved.pull.filter((f) => kinds.has(f.kind));
      return textResult({ item: id, ...resolved });
    }
    case "harvest.pull": {
      const packRaw = args.pack as IndexedPack | undefined;
      if (!packRaw || !Array.isArray(packRaw.items)) {
        return errorResult("harvest.pull requires a 'pack' object with an 'items' array (e.g. from harvest.pack).");
      }
      const destination = str(args.destination) === "download" ? "download" : "local";
      const confirmLarge = args.confirm_large === true;
      const tokens = tokensFrom(args);
      const packName = str(packRaw.name) || "pack";
      const baseDir = str(args.dir) ?? join(tmpdir(), "harvest-pulls", sanitizeId(packName));
      const pack: IndexedPack = { ...packRaw, index: { ...(packRaw.index ?? {}) } };

      // 1. Resolve every item up front (the loot preview for the whole pack).
      const resolved: Array<{
        it: IndexedPack["items"][number];
        r: Awaited<ReturnType<typeof resolveItem>> | null;
        error?: string;
      }> = [];
      for (const it of pack.items) {
        try {
          const r = await resolveItem(
            {
              id: it.id,
              source: it.source,
              kind: it.kind,
              url: it.url,
              ingest: it.ingest,
            },
            { hfToken: tokens.hf, ghToken: tokens.gh },
          );
          // Optional kind filter (the code-pack flow): restrict the pull list
          // before the size gate so the gate measures what will download.
          const kinds = kindsFrom(args.kinds);
          if (kinds) r.pull = r.pull.filter((f) => kinds.has(f.kind));
          resolved.push({ it, r });
        } catch (e) {
          resolved.push({ it, r: null, error: (e as Error).message });
        }
      }

      // 2. Size gate across the whole pull before a byte moves.
      const filesOver = resolved.flatMap(({ it, r }) =>
        r ? r.pull.filter((f) => f.bytes != null && f.bytes > DEFAULT_MAX_FILE_BYTES).map((f) => `${it.id}:${f.path}`) : [],
      );
      const totalBytes = resolved.reduce(
        (n, { r }) => n + (r ? r.pull.reduce((m, f) => m + (f.bytes ?? 0), 0) : 0),
        0,
      );
      if (!confirmLarge && (filesOver.length > 0 || totalBytes > DEFAULT_MAX_TOTAL_BYTES)) {
        return textResult({
          pack,
          destination,
          dir: baseDir,
          pulled: [],
          failed: [],
          needs_confirm: { files_over: filesOver, total_bytes: totalBytes },
        });
      }

      // 3. Fetch each item; merge fetched + resumed files from the ledger so
      // the index and manifest stay complete either way.
      const pulled: Array<{ id: string; files: number; bytes: number }> = [];
      const failed: Array<{ id: string; error: string }> = [];
      const itemFiles: Array<{ itemId: string; files: FetchedFile[] }> = [];
      for (const { it, r, error } of resolved) {
        if (!r) {
          failed.push({ id: it.id, error: error ?? "resolve failed" });
          continue;
        }
        const token = it.source === "github" ? tokens.gh : tokens.hf;
        if (r.needs_token && !token) {
          failed.push({ id: it.id, error: "gated/private item — pass hf_token/gh_token to pull it" });
          continue;
        }
        const itemDir = join(baseDir, sanitizeId(it.id));
        const fr = await fetchPullList(r, itemDir, { token, confirmLarge: true });
        const failedPaths = new Set(fr.failed.map((f) => f.path));
        if (fr.failed.length && !fr.fetched.length && fr.skipped_resume === 0) {
          failed.push({ id: it.id, error: fr.failed[0].error });
          continue;
        }
        const ledger = await loadLedger(itemDir);
        const complete: FetchedFile[] = [];
        for (const f of r.pull) {
          if (failedPaths.has(f.path)) continue;
          const got = fr.fetched.find((x) => x.path === f.path);
          if (got) complete.push(got);
          else if (ledger[f.path]) complete.push({ path: f.path, ...ledger[f.path] });
        }
        const bytes = complete.reduce((n, f) => n + f.bytes, 0);
        pulled.push({ id: it.id, files: complete.length, bytes });
        itemFiles.push({ itemId: it.id, files: complete });
        pack.index![it.id] = {
          local: itemDir,
          url: it.url,
          kind: it.kind,
          license: it.license ?? null,
          fetched_at: new Date().toISOString(),
          files: complete.map((f) => f.path),
        };
      }

      // 4. Optional zip bundle for the "download" destination.
      let bundle: { path: string; bytes: number } | undefined;
      if (destination === "download" && itemFiles.length > 0) {
        const zipPath = join(baseDir, `${sanitizeId(packName)}.harvest.zip`);
        const br = await bundlePack(pack, baseDir, zipPath, itemFiles);
        bundle = { path: br.zipPath, bytes: br.bytes };
      }

      return textResult({ pack, destination, dir: baseDir, pulled, failed, ...(bundle ? { bundle } : {}) });
    }
    case "harvest.push": {
      const bundle = str(args.bundle);
      const owner = str(args.owner);
      const repo = str(args.repo);
      if (!bundle || !owner || !repo) {
        return errorResult("harvest.push requires 'bundle' (zip path or dir), 'owner', and 'repo'.");
      }
      const token = str(args.token) ?? process.env.GITHUB_TOKEN;
      if (!token) return errorResult("harvest.push requires a per-call 'token' (GitHub PAT). It is never stored.");
      const res = await pushPack(
        bundle,
        {
          token,
          owner,
          repo,
          branch: str(args.branch),
          createIfMissing: args.create_if_missing === true,
          path: str(args.path),
        },
        str(args.pack_name) ?? repo,
      );
      return textResult(res);
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleCall(name, (args ?? {}) as Args);
    } catch (err) {
      return errorResult(`harvest-mcp error in ${name}: ${(err as Error)?.message ?? String(err)}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only — stdout is the MCP wire.
  console.error(`[${PKG_NAME}] fatal:`, err);
  process.exit(1);
});
