import { EXPERTS } from "../experts.js";
import type { ComposePick, ExpertId } from "../types.js";

export function parseComposeJson(
  text: string,
  known: Set<string>,
): { title: string; rationale: string; picks: ComposePick[] } | null {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      title?: string;
      rationale?: string;
      picks?: ComposePick[];
    };
    const picks = (parsed.picks ?? []).filter((p) => known.has(p.id)).slice(0, 24);
    if (!picks.length) return null;
    return {
      title: parsed.title ?? "Composed mix",
      rationale: parsed.rationale ?? "",
      picks,
    };
  } catch {
    return null;
  }
}

export function composeUserPayload(
  goal: string,
  catalog: Array<{ id: string; source: string; expert: ExpertId; description?: string }>,
) {
  return JSON.stringify({
    goal: goal.slice(0, 400),
    experts: EXPERTS.map((e) => e.id),
    catalog,
    instruction:
      "Pick 16–24 items covering as many experts as possible. Prefer diversity of source (huggingface + github) and skip near-duplicates. Return { title, rationale, picks:[{id, expert, why}] }.",
  });
}

export const COMPOSE_SYSTEM =
  "You compose mix-of-experts training libraries. Pick a balanced set from the given catalog only. Never invent ids. Reply JSON only.";
