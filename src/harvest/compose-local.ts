import { EXPERTS } from "../experts.js";
import type { ComposeOk, ExpertId } from "../types.js";

export type SlimItem = {
  id: string;
  source: string;
  expert: ExpertId;
  description?: string;
};

function titleFromGoal(goal: string) {
  const g = goal.trim();
  if (!g) return "Field mix";
  const cut = (g.split(/[.!?]/)[0] ?? g).trim();
  if (cut.length <= 42) return cut;
  return `${cut.slice(0, 40).replace(/\s+\S*$/, "")}…`;
}

export function composeLocal(goal: string, catalog: SlimItem[]): ComposeOk {
  const byExpert = new Map<ExpertId, SlimItem[]>();
  for (const e of EXPERTS) byExpert.set(e.id, []);
  for (const c of catalog) {
    const list = byExpert.get(c.expert);
    if (list) list.push(c);
  }

  const picks: ComposeOk["picks"] = [];
  const used = new Set<string>();
  const owners = new Map<string, number>();

  function take(item: SlimItem, why: string) {
    if (used.has(item.id)) return false;
    const owner = item.id.split("/")[0] ?? "";
    if ((owners.get(owner) ?? 0) >= 3) return false;
    used.add(item.id);
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    picks.push({ id: item.id, expert: item.expert, why });
    return true;
  }

  for (const e of EXPERTS) {
    const list = byExpert.get(e.id) ?? [];
    const hf = list.find((x) => x.source === "huggingface");
    const gh = list.find((x) => x.source === "github");
    if (hf) take(hf, `Anchor ${e.short} on Hugging Face`);
    else if (gh) take(gh, `Anchor ${e.short} from GitHub`);
  }

  for (const e of EXPERTS) {
    if (picks.length >= 22) break;
    const list = byExpert.get(e.id) ?? [];
    const haveHf = picks.some((p) => {
      if (p.expert !== e.id) return false;
      return catalog.find((c) => c.id === p.id)?.source === "huggingface";
    });
    const next = list.find(
      (x) => !used.has(x.id) && (haveHf ? x.source === "github" : x.source === "huggingface"),
    );
    if (next) take(next, `Balance ${e.short} source mix`);
  }

  for (const c of catalog) {
    if (picks.length >= 20) break;
    take(c, "Coverage fill");
  }

  const filled = new Set(picks.map((p) => p.expert)).size;
  return {
    ok: true,
    title: titleFromGoal(goal),
    rationale: `Local mixer staged ${picks.length} items across ${filled}/${EXPERTS.length} experts. No mouth required.`,
    picks,
    engine: "local",
  };
}
