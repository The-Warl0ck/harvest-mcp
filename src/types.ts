export type SourceKind = "huggingface" | "github";
export type ItemKind = "dataset" | "repo";

export type ExpertId =
  | "code"
  | "math"
  | "science"
  | "language"
  | "vision"
  | "audio"
  | "medical"
  | "law"
  | "knowledge"
  | "safety"
  | "affect"
  | "systems";

export type ScanOrigin = "atlas" | "live" | "latest" | "search" | "compose";

export type HarvestItem = {
  id: string;
  source: SourceKind;
  kind: ItemKind;
  name: string;
  owner: string;
  url: string;
  description: string;
  expert: ExpertId;
  tags: string[];
  license: string | null;
  downloads: number | null;
  likes: number | null;
  stars: number | null;
  language: string | null;
  lastModified: string | null;
  gated: boolean;
  origin: ScanOrigin;
};

export type Library = {
  id: string;
  name: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  itemIds: string[];
};

export type BridgeStatus = "unknown" | "connected" | "offline";

export type ComposeMode = "auto" | "local" | "mouth" | "cloud";
export type ComposeEngine = "local" | "mouth" | "cloud";
export type ComposePick = { id: string; expert?: ExpertId; why?: string };

export type ComposeOk = {
  ok: true;
  title: string;
  rationale: string;
  picks: ComposePick[];
  engine: ComposeEngine;
};

export type ComposeFail = { ok: false; error: string };
export type ComposeResult = ComposeOk | ComposeFail;

export type HarvestPack = {
  format: "flare-harvest-library";
  version: 1;
  product: "Harvest";
  name: string;
  goal: string;
  createdAt: string;
  coverage: {
    filled: number;
    totalExperts: number;
    balance: number;
  };
  items: Array<{
    source: SourceKind;
    kind: ItemKind;
    id: string;
    url: string;
    expert: ExpertId;
    description: string;
    license: string | null;
    ingest: {
      type: "hf-dataset" | "github-repo";
      ref: string;
    };
  }>;
  // Optional. The open pack format omits this; a Bridge host may attach it.
  bridge?: {
    ingestPath: "/api/train/ingest";
    suggestedPack: string;
  };
};
