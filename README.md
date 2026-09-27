# harvest-mcp

**Plain-English topic in → 12 experts fan out over Hugging Face + GitHub in parallel → coverage-scored training pack JSON out in ~30 seconds.**

No API keys. No Bridge. No account. Works out of the box once connected to any MCP host — no LLM inside; your agent brings the thinking.

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

The second half — the hands. Packs start as pointers; pull turns them into files:

> **harvest.resolve** `{ "item": { "id": "openai/gsm8k", "source": "huggingface" } }`
> → the loot preview: 4 parquet shards + README, each with a one-line reason, nothing stupid

> **harvest.pull** `{ "pack": {…}, "destination": "download" }`
> → resolves + fetches every item, updates the pack's `index` stanza, and builds
> `VLM Mix v1.harvest.zip` — one file with everything plus `MANIFEST.json` provenance

> **harvest.push** `{ "bundle": "/path/to/VLM Mix v1.harvest.zip", "owner": "you", "repo": "my-data", "token": "ghp_…", "create_if_missing": true }`
> → one commit on a new private repo: files + manifest, message says what it is and where it came from

## Tools

| Tool | What it does |
|---|---|
| `harvest.search` | `{topic, hf_token?, gh_token?}` — topic search + full 12-expert atlas sweep, deduplicated |
| `harvest.expert` | `{expert, hf_token?, gh_token?}` — run one expert's curated queries (12 ids: `code`, `math`, `science`, `language`, `vision`, `audio`, `medical`, `law`, `knowledge`, `safety`, `affect`, `systems`) |
| `harvest.latest` | `{}` — trending: recently-updated HF datasets, hot/recent GitHub repos |
| `harvest.compose` | `{goal, catalog}` — local mixer composes a balanced set; picks + rationale (the mixer itself needs no LLM) |
| `harvest.pack` | `{goal, catalog, name}` — compose + entropy coverage scoring → `flare-harvest-library` v1 pack JSON |
| `harvest.resolve` | `{item, hf_token?, gh_token?}` — pull-list preview for one pack item: which files, why, and `needs_token` for gated items. No downloading |
| `harvest.pull` | `{pack, destination: "local" \| "download", dir?, confirm_large?, hf_token?, gh_token?}` — resolve + fetch + index update for the whole pack; `"download"` also builds a `.harvest.zip`. Oversized pulls return `needs_confirm` first |
| `harvest.push` | `{bundle, pack_name?, owner, repo, token, create_if_missing?, branch?, path?}` — push a bundle to GitHub in one commit (private by default when creating) |

`catalog` items are `{ id, source, expert, description? }` — the objects `harvest.search` returns drop straight in.

## Rate limits

Everything hits the **public** Hugging Face and GitHub APIs. Unauthenticated, you get:

- **Hugging Face:** generous anonymous quota on `/api/datasets` (occasional 429s on bursts; results are cached 12 min in-process)
- **GitHub:** 60 requests/hour per IP for search — the 12-expert sweep is the hungriest call

For real use, set `HF_TOKEN` / `GITHUB_TOKEN` (free accounts) via env or the per-call
`hf_token` / `gh_token` args. See `.env.example`.

## Pack format

Packs are `flare-harvest-library` v1 JSON — see [PACK-FORMAT.md](PACK-FORMAT.md).

### Pointer vs. pulled

A fresh pack is **pointers, not data**: each item names its source and how to
ingest it, but no files. `harvest.pull` turns pointers into files and records
the result in an additive `index` stanza on the pack JSON:

```json
{ "index": { "openai/gsm8k": { "local": "/tmp/harvest-pulls/pack/openai__gsm8k",
  "url": "https://huggingface.co/datasets/openai/gsm8k", "kind": "dataset",
  "license": null, "fetched_at": "2026-09-26T…", "files": ["main/train-….parquet", …] } } }
```

v1 readers ignore the stanza safely; packs without it load as pointer-only.
`destination: "download"` additionally produces a `.harvest.zip` containing the
files plus `MANIFEST.json` (source, URL, license, SHA-256 per file — licenses
are reported as `unknown` when the pack doesn't state one, never guessed).

### Token story

Tokens are **passed per call, never stored**:

- `harvest.search` / `harvest.expert` / `harvest.latest` / `harvest.resolve` / `harvest.pull`
  accept `hf_token` / `gh_token` (or the `HF_TOKEN` / `GITHUB_TOKEN` env vars) —
  used for higher rate limits and gated datasets, sent only as an
  `Authorization` header.
- `harvest.push` takes a per-call `token` (GitHub PAT, or `GITHUB_TOKEN` env).
- No token is ever written to disk, to logs, to a pack file, or to a manifest.
  Fetch resume ledgers (`.harvest-fetch.json`) hold only paths, byte counts,
  and hashes.

## How it works

- `src/harvest/scan-core.ts` — parallel HF/GitHub scanning, 12-min result cache
- `src/experts.ts` — the 12-expert atlas (curated queries + seed items)
- `src/harvest/compose-local.ts` — the local mixer ("No mouth required"): anchors one item per expert, then balances HF/GitHub sources, then fills for coverage
- `src/coverage.ts` — entropy-based coverage/balance scoring across the 12 experts
- `src/harvest/compose-mouth.ts` — opt-in: compose via any OpenAI-compatible `/v1` endpoint (LM Studio, etc.) instead of the local mixer
- `src/harvest/resolve.ts` — the "which files" intelligence: HF Hub / GitHub tree listings classified into data, weights, config, code, docs (pure functions + thin API clients)
- `src/harvest/fetch.ts` — the hands: streaming downloads with resume, size guards, progress, SHA-256 per file; token arrives as a function arg, never stored
- `src/harvest/bundle.ts` — zips a fetched dir + `MANIFEST.json` provenance into a `.harvest.zip`
- `src/harvest/push.ts` — pushes a bundle to GitHub via the Git Data API: one commit, private by default (`// TODO(GitLab)` seam sketched)
- `src/harvest/index.ts` — the agent side: additive `index` stanza + `resolvePointer` / `getItemFiles` / `queryIndex`
- `mcp/server.ts` — the MCP server (stdio, low-level SDK API, hand-written schemas)

## License

Apache-2.0 — see [LICENSE](LICENSE).
