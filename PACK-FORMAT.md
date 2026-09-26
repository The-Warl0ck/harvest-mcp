# flare-harvest-library v1 — Pack Format

Harvest packs describe a **training library**: a curated set of Hugging Face datasets
and GitHub repos, composed for coverage across 12 domain experts.

## Schema

```jsonc
{
  "format": "flare-harvest-library",   // string, always this value
  "version": 1,                        // number, always 1
  "product": "Harvest",                // string, producer name
  "name": "VLM Mix v1",                // string, human pack name
  "goal": "small vision-language model", // string, the goal it was composed for
  "createdAt": "2026-09-26T03:00:00.000Z", // ISO-8601 timestamp
  "coverage": {
    "filled": 12,        // experts with ≥1 item
    "totalExperts": 12,  // always 12 in v1
    "balance": 0.941     // normalized Shannon entropy of the expert distribution, 0–1
  },
  "items": [
    {
      "source": "huggingface",          // "huggingface" | "github"
      "kind": "dataset",                // "dataset" | "repo"
      "id": "lmms-lab/LLaVA-NeXT-Data", // registry id (owner/name)
      "url": "https://huggingface.co/datasets/lmms-lab/LLaVA-NeXT-Data",
      "expert": "vision",               // one of the 12 expert ids
      "description": "LLaVA-style visual instruction.",
      "license": "apache-2.0",          // SPDX id or null if unknown
      "ingest": {
        "type": "hf-dataset",           // "hf-dataset" | "github-repo"
        "ref": "lmms-lab/LLaVA-NeXT-Data"
      }
    }
  ],
  // "bridge" is OPTIONAL and omitted by the open MCP server.
  // A Bridge host may attach: { "ingestPath": "/api/train/ingest", "suggestedPack": "harvest-vlm-mix-v1" }
}
```

## The 12 experts

`code`, `math`, `science`, `language`, `vision`, `audio`, `medical`, `law`,
`knowledge`, `safety`, `affect`, `systems`.

## Coverage scoring

`coverageOf(items)` counts items per expert, then:

- `filled` = experts with at least one item
- `coverage` = `filled / 12`
- `balance` = Shannon entropy of the per-expert distribution ÷ `log2(12)` —
  1.0 means perfectly even spread, lower means concentrated
- `gaps` = expert ids with zero items (returned by `coverageOf`, not stored in the pack)

## Notes

- Packs are **pointers, not data**: each item carries `url` + `ingest.ref` so a
  training pipeline can pull the dataset/repo itself.
- `harvest.pull` adds an **optional `index` stanza** (additive — v1 readers
  ignore it safely): `{ "<item-id>": { "local": "/abs/path", "url", "kind",
  "license", "fetched_at", "files": [...] } }`. `local` is absent for
  pointer-only items; packs without `index` load as pointer-only.
- `license` is best-effort metadata from the source registries — verify before
  training commercially. Pull manifests report `unknown` when unstated, never guessed.
- v1 has no content hashes; consumers should pin revisions themselves.
