# harvest-mcp

**Plain-English topic in → 12 experts fan out over Hugging Face + GitHub in parallel → coverage-scored training pack JSON out in ~30 seconds.**

No API keys. No Bridge. No account. It works out of the box.

Harvest is a training-data scout: you describe what you want to train on in plain English
("image classification", "medical question answering"), and 12 domain experts —
code, math, science, language, vision, audio, medical, law, knowledge, safety, affect, systems —
each sweep Hugging Face datasets and GitHub repos with their own curated queries. The local mixer
then composes the hits into a balanced, coverage-scored training library pack
(`flare-harvest-library` v1 JSON) you can hand to any training pipeline.

## Install

```bash
npx github:The-Warl0ck/harvest-mcp
```

Or add it to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "harvest": {
      "command": "npx",
      "args": ["github:The-Warl0ck/harvest-mcp"]
    }
  }
}
```

With optional tokens for higher rate limits:

```json
{
  "mcpServers": {
    "harvest": {
      "command": "npx",
      "args": ["github:The-Warl0ck/harvest-mcp"],
      "env": {
        "HF_TOKEN": "hf_...",
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

Requirements: Node.js ≥ 20.

## Example session

> **You:** find me training data for a small vision-language model

> **harvest.search** `{ "topic": "vision language instruction tuning" }`
> → ~40 hits: LLaVA-NeXT data, the Cauldron, DOCCI, LLaVA repo… plus the
> 12-expert atlas sweep for breadth (code, math, safety…)

> **harvest.compose** `{ "goal": "small vision-language model", "catalog": […] }`
> → `{ "title": "small vision-language model", "picks": [ { "id": "lmms-lab/LLaVA-NeXT-Data", "expert": "vision", "why": "Anchor Vision on Hugging Face" }, … ], "rationale": "Local mixer staged 22 items across 12/12 experts. No mouth required.", "engine": "local" }`

> **harvest.pack** `{ "goal": "small vision-language model", "name": "VLM Mix v1", "catalog": […] }`
> → `flare-harvest-library` v1 JSON with `coverage: { filled: 12, totalExperts: 12, balance: 0.94 }`
> and per-item `ingest: { type: "hf-dataset" | "github-repo", ref }` pointers.

## Tools

| Tool | What it does |
|---|---|
| `harvest.search` | `{topic, hf_token?, gh_token?}` — topic search + full 12-expert atlas sweep, deduplicated |
| `harvest.expert` | `{expert, hf_token?, gh_token?}` — run one expert's curated queries (12 ids: `code`, `math`, `science`, `language`, `vision`, `audio`, `medical`, `law`, `knowledge`, `safety`, `affect`, `systems`) |
| `harvest.latest` | `{}` — trending: recently-updated HF datasets, hot/recent GitHub repos |
| `harvest.compose` | `{goal, catalog}` — local mixer composes a balanced set; picks + rationale, no LLM needed |
| `harvest.pack` | `{goal, catalog, name}` — compose + entropy coverage scoring → `flare-harvest-library` v1 pack JSON |

`catalog` items are `{ id, source, expert, description? }` — the objects `harvest.search` returns drop straight in.

## Rate limits

Everything hits the **public** Hugging Face and GitHub APIs. Unauthenticated, you get:

- **Hugging Face:** generous anonymous quota on `/api/datasets` (occasional 429s on bursts; results are cached 12 min in-process)
- **GitHub:** 60 requests/hour per IP for search — the 12-expert sweep is the hungriest call

For real use, set `HF_TOKEN` / `GITHUB_TOKEN` (free accounts) via env or the per-call
`hf_token` / `gh_token` args. See `.env.example`.

## Pack format

Packs are `flare-harvest-library` v1 JSON — see [PACK-FORMAT.md](PACK-FORMAT.md).

## How it works

- `src/harvest/scan-core.ts` — parallel HF/GitHub scanning, 12-min result cache
- `src/experts.ts` — the 12-expert atlas (curated queries + seed items)
- `src/harvest/compose-local.ts` — the local mixer ("No mouth required"): anchors one item per expert, then balances HF/GitHub sources, then fills for coverage
- `src/coverage.ts` — entropy-based coverage/balance scoring across the 12 experts
- `src/harvest/compose-mouth.ts` — opt-in: compose via any OpenAI-compatible `/v1` endpoint (LM Studio, etc.) instead of the local mixer
- `mcp/server.ts` — the MCP server (stdio, low-level SDK API, hand-written schemas)

## License

Apache-2.0 — see [LICENSE](LICENSE).
