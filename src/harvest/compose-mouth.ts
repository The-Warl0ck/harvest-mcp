import type { ComposeOk, ExpertId } from "../types.js";
import { COMPOSE_SYSTEM, composeUserPayload, parseComposeJson } from "./compose-parse.js";
import { harvestFetch } from "./net.js";

type Slim = {
  id: string;
  source: string;
  expert: ExpertId;
  description?: string;
};

function headers(token: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await harvestFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function mouthReachable(baseUrl: string, token: string): Promise<boolean> {
  const base = baseUrl.replace(/\/$/, "");
  if (!base) return false;
  try {
    const res = await timedFetch(`${base}/v1/models`, { headers: headers(token) }, 1200);
    return res.ok;
  } catch {
    return false;
  }
}

async function pickModel(base: string, token: string): Promise<string> {
  try {
    const res = await timedFetch(`${base}/v1/models`, { headers: headers(token) }, 1500);
    if (!res.ok) return "local";
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return body.data?.[0]?.id || "local";
  } catch {
    return "local";
  }
}

export async function composeViaMouth(
  baseUrl: string,
  token: string,
  goal: string,
  catalog: Slim[],
): Promise<ComposeOk | null> {
  const base = baseUrl.replace(/\/$/, "");
  if (!base) return null;
  const slim = catalog.slice(0, 80).map((c) => ({
    id: c.id,
    source: c.source,
    expert: c.expert,
  }));
  const known = new Set(slim.map((s) => s.id));
  try {
    const model = await pickModel(base, token);
    const res = await timedFetch(
      `${base}/v1/chat/completions`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          model,
          max_tokens: 900,
          temperature: 0.3,
          messages: [
            { role: "system", content: COMPOSE_SYSTEM },
            { role: "user", content: composeUserPayload(goal, slim) },
          ],
        }),
      },
      8000,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = parseComposeJson(body.choices?.[0]?.message?.content ?? "", known);
    if (!parsed) return null;
    return { ok: true, ...parsed, engine: "mouth" };
  } catch {
    return null;
  }
}
