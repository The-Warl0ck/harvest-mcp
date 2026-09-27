import { EXPERTS } from "./experts.js";
import type { ExpertId, HarvestItem, HarvestPack, Library } from "./types.js";

export type Coverage = {
  counts: Record<ExpertId, number>;
  filled: number;
  totalExperts: number;
  coverage: number;
  balance: number;
  total: number;
  gaps: ExpertId[];
};

export function coverageOf(items: HarvestItem[]): Coverage {
  const counts = Object.fromEntries(EXPERTS.map((e) => [e.id, 0])) as Record<
    ExpertId,
    number
  >;
  for (const it of items) {
    if (it.expert in counts) counts[it.expert] += 1;
  }
  const values = EXPERTS.map((e) => counts[e.id]);
  const filled = values.filter((v) => v > 0).length;
  const total = values.reduce((a, b) => a + b, 0);
  const probs = values.map((v) => (total === 0 ? 0 : v / total));
  const entropy = -probs.reduce((s, p) => s + (p > 0 ? p * Math.log2(p) : 0), 0);
  const maxH = Math.log2(EXPERTS.length);
  const balance = total === 0 ? 0 : entropy / maxH;
  const gaps = EXPERTS.filter((e) => counts[e.id] === 0).map((e) => e.id);
  return {
    counts,
    filled,
    totalExperts: EXPERTS.length,
    coverage: filled / EXPERTS.length,
    balance,
    total,
    gaps,
  };
}

export function libraryItems(library: Library, catalog: HarvestItem[]): HarvestItem[] {
  const byId = new Map(catalog.map((i) => [i.id, i]));
  return library.itemIds.map((id) => byId.get(id)).filter((x): x is HarvestItem => !!x);
}

type PackItemOut = HarvestPack["items"][number];

function packItems(items: HarvestItem[]): PackItemOut[] {
  return items.map((it) => ({
    source: it.source,
    kind: it.kind,
    id: it.id,
    url: it.url,
    expert: it.expert,
    description: it.description,
    license: it.license,
    ingest: {
      type: it.source === "huggingface" ? "hf-dataset" : "github-repo",
      ref: it.id,
    },
  }));
}

export function toPack(
  library: Library,
  items: HarvestItem[],
  cov: Coverage,
): HarvestPack {
  return {
    format: "flare-harvest-library",
    version: 1,
    product: "Harvest",
    name: library.name,
    goal: library.goal,
    createdAt: new Date().toISOString(),
    coverage: {
      filled: cov.filled,
      totalExperts: cov.totalExperts,
      balance: Number(cov.balance.toFixed(3)),
    },
    items: packItems(items),
    // No `bridge` stanza in the open pack: a Bridge host may attach one
    // itself (see `bridge?:` in types.ts).
  };
}

/**
 * A code build pack: the same item envelope as a library pack, but no
 * coverage scoring. The pack is a parts bin — an agent pulls it
 * (harvest.pull, optionally with kinds: ["code","docs"]) and builds from
 * the parts. Format discriminator lets consumers tell the two apart.
 */
export function toCodePack(library: Library, items: HarvestItem[]): HarvestPack {
  return {
    format: "flare-harvest-codepack",
    version: 1,
    product: "Harvest",
    name: library.name,
    goal: library.goal,
    createdAt: new Date().toISOString(),
    items: packItems(items),
    // No `bridge` stanza in the open pack: a Bridge host may attach one
    // itself (see `bridge?:` in types.ts).
  };
}
