// Harvest index — the agent side of the pack.
// A pack JSON gains an optional `index` stanza (v1 readers ignore it safely):
//   { index: { "<item-id>": { local?, url, kind, license, fetched_at?, files? } } }
// Present whether files were fetched locally or not — `local` is simply
// absent for pointer-only items. Old packs without `index` load as
// pointer-only. queryIndex never touches the network.

import { join } from "node:path";
import type { ExpertId, HarvestPack } from "../types.js";
import { fetchPullList, type FetchedFile } from "./fetch.js";
import { resolveItem } from "./resolve.js";

export type IndexEntry = {
  /** Absolute dir holding this item's fetched files. Absent = pointer-only. */
  local?: string;
  url: string;
  kind: string;
  license: string | null;
  fetched_at?: string;
  /** Relative file paths under `local`. */
  files?: string[];
};

export type PackIndex = Record<string, IndexEntry>;

/** A pack with the optional additive index stanza. */
export type IndexedPack = HarvestPack & { index?: PackIndex };

export type IndexQuery = {
  expert?: ExpertId;
  kind?: string;
  license?: string;
};

export type IndexHit = {
  id: string;
  expert: ExpertId;
  kind: string;
  license: string | null;
  url: string;
  local?: string;
  files?: string[];
};

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "__").slice(0, 120);
}

/**
 * Resolve one item id to its index entry. Falls back to a pointer-only
 * entry built from the pack's item list (old packs, unfetched items).
 */
export function resolvePointer(itemId: string, pack: IndexedPack): IndexEntry | null {
  const hit = pack.index?.[itemId];
  if (hit) return hit;
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) return null;
  return { url: item.url, kind: item.kind, license: item.license ?? null };
}

/**
 * Filter the shelf without touching the network. Matches pack items against
 * the query, joining whatever the index knows (local paths when fetched).
 */
export function queryIndex(pack: IndexedPack, query: IndexQuery = {}): IndexHit[] {
  return pack.items
    .filter((i) => !query.expert || i.expert === query.expert)
    .filter((i) => !query.kind || i.kind === query.kind)
    .filter((i) => {
      if (!query.license) return true;
      const lic = i.license ?? "unknown";
      return lic.toLowerCase() === query.license.toLowerCase();
    })
    .map((i) => {
      const entry = pack.index?.[i.id];
      return {
        id: i.id,
        expert: i.expert,
        kind: i.kind,
        license: i.license ?? null,
        url: i.url,
        ...(entry?.local ? { local: entry.local, files: entry.files ?? [] } : {}),
      };
    });
}

export type GetItemFilesOpts = {
  token?: string;
  destDir?: string;
  userAgent?: string;
};

export type GetItemFilesResult = {
  itemId: string;
  /** Absolute paths of the item's files on disk. */
  paths: string[];
  fetched: FetchedFile[];
  /** The pack with its index stanza updated for this item. */
  pack: IndexedPack;
};

/**
 * Resolve-on-demand: return the item's files, fetching just this item's
 * pull list now when it isn't local yet, and recording it in the index.
 */
export async function getItemFiles(
  itemId: string,
  pack: IndexedPack,
  opts: GetItemFilesOpts = {},
): Promise<GetItemFilesResult> {
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`item "${itemId}" not in pack`);

  const existing = pack.index?.[itemId];
  if (existing?.local) {
    const paths = (existing.files ?? []).map((f) => join(existing.local as string, f));
    return { itemId, paths, fetched: [], pack };
  }

  const destDir = opts.destDir ?? join(process.cwd(), "harvest-pulls");
  const itemDir = join(destDir, sanitizeId(itemId));
  const resolved = await resolveItem(
    {
      id: item.id,
      source: item.source,
      kind: item.kind,
      url: item.url,
      ingest: item.ingest,
    },
    { hfToken: opts.token, ghToken: opts.token, userAgent: opts.userAgent },
  );
  const fr = await fetchPullList(resolved, itemDir, { token: opts.token, userAgent: opts.userAgent });
  if (fr.needs_confirm) {
    throw new Error(
      `refusing to pull "${itemId}" without confirmation (${fr.needs_confirm.total_bytes} bytes)`,
    );
  }
  if (fr.failed.length && !fr.fetched.length) {
    throw new Error(`fetch failed for "${itemId}": ${fr.failed[0].error}`);
  }

  const entry: IndexEntry = {
    local: itemDir,
    url: item.url,
    kind: item.kind,
    license: item.license ?? null,
    fetched_at: new Date().toISOString(),
    files: fr.fetched.map((f) => f.path),
  };
  const next: IndexedPack = { ...pack, index: { ...(pack.index ?? {}), [itemId]: entry } };
  return {
    itemId,
    paths: fr.fetched.map((f) => join(itemDir, f.path)),
    fetched: fr.fetched,
    pack: next,
  };
}
