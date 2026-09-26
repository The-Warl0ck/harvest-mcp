// Harvest network layer — plain-Node edition.
// No Electron/desktop shims, no Vite `import.meta.env` (which throws in plain Node).
// All scanning goes through global fetch against the public HF/GitHub APIs.

export type ScanEnv = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  hfBase: string;
  ghBase: string;
  userAgent?: string;
};

export async function harvestFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, init);
}

function joinUrl(base: string, path: string): URL {
  const b = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), b);
}

export function hfUrl(env: ScanEnv, path: string, params: Record<string, string>): URL {
  const url = joinUrl(env.hfBase, path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

export function ghUrl(env: ScanEnv, path: string, params: Record<string, string>): URL {
  const url = joinUrl(env.ghBase, path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

// Default env for plain Node: direct HTTPS to the public APIs, no dev proxies,
// no window/desktop checks, and — critically — no `import.meta.env` access.
export function defaultScanEnv(): ScanEnv {
  return nodeScanEnv();
}

export function nodeScanEnv(): ScanEnv {
  return {
    fetch: (url, init) => harvestFetch(url, init),
    hfBase: "https://huggingface.co",
    ghBase: "https://api.github.com",
    userAgent: "harvest-mcp/0.1.0",
  };
}
