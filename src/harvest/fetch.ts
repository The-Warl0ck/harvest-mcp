// Harvest downloader ("the hands").
// Streams a resolved pull list to disk with resume, size guards, progress,
// and a SHA-256 per file. The token arrives as a function arg and is never
// written to disk or logged — it only ever leaves in an Authorization header.

import { createWriteStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import type { PullFile, ResolvedPull } from "./resolve.js";

export type FetchProgress = {
  file: string;
  done_bytes: number;
  total_bytes: number | null;
};

export type FetchOpts = {
  /** Bearer token for HF/GitHub. Passed through only — never stored or logged. */
  token?: string;
  userAgent?: string;
  onProgress?: (p: FetchProgress) => void;
  /** Per-file cap. Default 2 GB. */
  maxFileBytes?: number;
  /** Whole-list cap (sum of known sizes). Default 10 GB. */
  maxTotalBytes?: number;
  /** Set when the caller already confirmed a needs_confirm result. */
  confirmLarge?: boolean;
};

export type FetchedFile = { path: string; bytes: number; sha256: string };
export type FetchFailure = { path: string; error: string };

export type FetchResult = {
  fetched: FetchedFile[];
  failed: FetchFailure[];
  /** Files skipped because an identical-size copy was already on disk. */
  skipped_resume: number;
  needs_confirm?: { files_over: string[]; total_bytes: number };
};

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

/** Name of the local fetch ledger inside a destination dir. */
export const FETCH_LEDGER = ".harvest-fetch.json";

export type LedgerEntry = { bytes: number; sha256: string };
export type FetchLedger = Record<string, LedgerEntry>;

export async function loadLedger(destDir: string): Promise<FetchLedger> {
  try {
    const raw = await fs.readFile(join(destDir, FETCH_LEDGER), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as FetchLedger;
  } catch {
    // no ledger yet — fine
  }
  return {};
}

async function saveLedger(destDir: string, ledger: FetchLedger): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(join(destDir, FETCH_LEDGER), JSON.stringify(ledger, null, 2));
}

/** Keep a pull-list path inside the destination dir (no ../ escapes). */
function safeJoin(destDir: string, rel: string): string {
  const abs = resolvePath(destDir, rel);
  const base = resolvePath(destDir) + sep;
  if (abs !== resolvePath(destDir) && !abs.startsWith(base)) {
    throw new Error(`unsafe pull path escapes destination: ${rel}`);
  }
  return abs;
}

function headers(opts: FetchOpts): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": opts.userAgent ?? "harvest-mcp/0.2.0" };
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  return h;
}

async function downloadOne(
  file: PullFile,
  destDir: string,
  opts: FetchOpts,
  maxFile: number,
  ledger: FetchLedger,
): Promise<{ fetched?: FetchedFile; resumed?: boolean; error?: string }> {
  let abs: string;
  try {
    abs = safeJoin(destDir, file.path);
  } catch (e) {
    return { error: (e as Error).message };
  }
  await fs.mkdir(dirname(abs), { recursive: true });

  // Size may be unknown from the listing (HF siblings often omit it) — a
  // cheap HEAD learns it so resume and progress still work.
  let expected: number | null = file.bytes ?? null;
  if (expected == null) {
    try {
      const head = await fetch(file.url, {
        method: "HEAD",
        headers: headers(opts),
        signal: AbortSignal.timeout(30_000),
      });
      const len = head.headers.get("content-length");
      if (head.ok && len && /^\d+$/.test(len)) expected = parseInt(len, 10);
    } catch {
      // fall through — download blind
    }
  }

  // Resume: if a complete copy is already there, skip it.
  let startAt = 0;
  if (expected != null) {
    try {
      const st = await fs.stat(abs);
      if (st.size === expected) return { resumed: true };
      if (st.size > 0 && st.size < expected) startAt = st.size;
    } catch {
      // not on disk yet — fresh download
    }
  } else {
    // Server won't tell us the size (compressed text responses): fall back to
    // the local ledger — if the bytes on disk match what we recorded, skip.
    const known = ledger[file.path];
    if (known) {
      try {
        const st = await fs.stat(abs);
        if (st.size === known.bytes) return { resumed: true };
      } catch {
        // gone — re-download below
      }
    }
  }

  const h = headers(opts);
  if (startAt > 0) h.Range = `bytes=${startAt}-`;

  let res: Response;
  try {
    res = await fetch(file.url, { headers: h, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    return { error: `network error: ${(e as Error).message}` };
  }
  if (res.status !== 200 && res.status !== 206) {
    // Token failures surface as errors here, never as token-bearing logs.
    return { error: `HTTP ${res.status} for ${file.path}` };
  }
  if (!res.body) return { error: `empty body for ${file.path}` };

  const appending = res.status === 206 && startAt > 0;
  const hash = createHash("sha256");
  if (appending) {
    // Hash the bytes already on disk so the digest covers the whole file.
    const prev = await fs.readFile(abs);
    hash.update(prev);
  }
  const stream = createWriteStream(abs, { flags: appending ? "a" : "w" });
  const total = expected;
  let done = startAt;

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      done += chunk.length;
      if (done > maxFile) {
        stream.destroy();
        await fs.unlink(abs).catch(() => {});
        return { error: `${file.path} exceeded the per-file cap mid-download` };
      }
      hash.update(chunk);
      await new Promise<void>((ok, bad) => {
        if (!stream.write(chunk, (err) => (err ? bad(err) : ok()))) stream.once("drain", ok);
      });
      opts.onProgress?.({ file: file.path, done_bytes: done, total_bytes: total });
    }
  } catch (e) {
    stream.destroy();
    return { error: `stream error on ${file.path}: ${(e as Error).message}` };
  }
  await new Promise<void>((ok, bad) => stream.end((err?: Error | null) => (err ? bad(err) : ok())));

  return { fetched: { path: file.path, bytes: done, sha256: hash.digest("hex") } };
}

/**
 * Fetch a resolved pull list into destDir.
 * Skips files already present with matching size, resumes partial files via
 * Range, guards oversized pulls with needs_confirm, hashes everything.
 */
export async function fetchPullList(
  resolved: ResolvedPull,
  destDir: string,
  opts: FetchOpts = {},
): Promise<FetchResult> {
  const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  if (resolved.needs_token && !opts.token) {
    return {
      fetched: [],
      failed: resolved.pull.map((f) => ({ path: f.path, error: "item needs a token (gated/private)" })),
      skipped_resume: 0,
    };
  }

  // Size guard runs before a single byte moves.
  const filesOver = resolved.pull.filter((f) => f.bytes != null && f.bytes > maxFile).map((f) => f.path);
  const knownTotal = resolved.pull.reduce((n, f) => n + (f.bytes ?? 0), 0);
  if (!opts.confirmLarge && (filesOver.length > 0 || knownTotal > maxTotal)) {
    return {
      fetched: [],
      failed: [],
      skipped_resume: 0,
      needs_confirm: { files_over: filesOver, total_bytes: knownTotal },
    };
  }

  const fetched: FetchedFile[] = [];
  const failed: FetchFailure[] = [];
  let skipped_resume = 0;
  const ledger = await loadLedger(destDir);
  for (const file of resolved.pull) {
    const r = await downloadOne(file, destDir, opts, maxFile, ledger);
    if (r.fetched) {
      fetched.push(r.fetched);
      ledger[file.path] = { bytes: r.fetched.bytes, sha256: r.fetched.sha256 };
      await saveLedger(destDir, ledger);
    } else if (r.resumed) skipped_resume++;
    else failed.push({ path: file.path, error: r.error ?? "unknown error" });
  }
  return { fetched, failed, skipped_resume };
}

export type { ResolvedPull, PullFile };
