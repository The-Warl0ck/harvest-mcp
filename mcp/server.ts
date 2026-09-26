#!/usr/bin/env node
/**
 * harvest-mcp — MCP server (stdio transport) for Harvest.
 *
 * Plain-English topic in -> 12 experts fan out over Hugging Face + GitHub ->
 * coverage-scored training pack JSON out. No API keys required, no Bridge.
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
import { coverageOf, toPack } from "../src/coverage.js";
import type { ExpertId, HarvestItem } from "../src/types.js";

const PKG_NAME = "harvest-mcp";
const PKG_VERSION = "0.1.0";

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
      "Compose a mix from a catalog and emit a flare-harvest-library v1 pack JSON with coverage scores. No Bridge stanza included.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What the training library is for.",
        },
        name: {
          type: "string",
          description: "Pack name, e.g. 'Vision Mix v1'.",
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
      const cov = coverageOf(items);
      const now = new Date().toISOString();
      return textResult(
        toPack(
          { id: `pack-${Date.now()}`, name, goal, createdAt: now, updatedAt: now, itemIds: items.map((i) => i.id) },
          items,
          cov,
        ),
      );
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
