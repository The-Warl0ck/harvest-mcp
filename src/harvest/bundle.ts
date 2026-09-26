// Harvest bundler — the one file you can hand someone.
// Zips a fetched directory plus a MANIFEST.json of provenance (source, url,
// license, hash per file). Licenses are reported as "unknown" when the pack
// doesn't state one — never guessed. Tokens never appear here.

import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { HarvestPack } from "../types.js";
import type { FetchedFile } from "./fetch.js";
import { FETCH_LEDGER } from "./fetch.js";

export type ItemFiles = { itemId: string; files: FetchedFile[] };

export type BundleResult = { zipPath: string; bytes: number; files: number };

export type ManifestFile = { path: string; bytes: number; sha256: string };
export type ManifestItem = {
  id: string;
  source: string;
  url: string;
  license: string;
  files: ManifestFile[];
};
export type PackManifest = {
  pack: string;
  created: string;
  items: ManifestItem[];
};

async function walk(dir: string, base: string, out: string[], skip: Set<string>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (skip.has(e.name)) continue; // local cache ledger / the zip itself — not shipped
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out, skip);
    else if (e.isFile()) out.push(relative(base, full));
  }
}

/**
 * Bundle a fetched directory into <outPath> (a .harvest.zip): the files in
 * their original relative layout plus MANIFEST.json provenance at the root.
 */
export async function bundlePack(
  pack: HarvestPack,
  fetchedDir: string,
  outPath: string,
  itemFiles: ItemFiles[] = [],
): Promise<BundleResult> {
  const relPaths: string[] = [];
  const skipName = basename(outPath);
  await walk(fetchedDir, fetchedDir, relPaths, new Set([skipName, FETCH_LEDGER]));
  relPaths.sort();

  const byItem = new Map(itemFiles.map((it) => [it.itemId, it.files]));
  const items: ManifestItem[] = pack.items.map((item) => {
    const files = (byItem.get(item.id) ?? [])
      .map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return {
      id: item.id,
      source: item.source,
      url: item.url,
      license: item.license ?? "unknown",
      files,
    };
  });

  const manifest: PackManifest = {
    pack: pack.name,
    created: new Date().toISOString(),
    items,
  };

  const entries: Record<string, Uint8Array> = {};
  for (const rel of relPaths) {
    entries[rel] = await fs.readFile(join(fetchedDir, rel));
  }
  entries["MANIFEST.json"] = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

  const zipped = zipSync(entries, { level: 6 });
  await fs.writeFile(outPath, zipped);
  return { zipPath: outPath, bytes: zipped.length, files: relPaths.length };
}

/** Read a bundle's manifest without extracting (for verify/inspect). */
export async function readBundleManifest(zipPath: string): Promise<PackManifest> {
  const data = await fs.readFile(zipPath);
  const entries = unzipSync(data);
  const raw = entries["MANIFEST.json"];
  if (!raw) throw new Error("bundle has no MANIFEST.json");
  return JSON.parse(Buffer.from(raw).toString("utf8")) as PackManifest;
}
