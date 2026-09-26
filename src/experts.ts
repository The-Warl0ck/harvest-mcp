import type { ExpertId, HarvestItem } from "./types.js";

export type ExpertDef = {
  id: ExpertId;
  name: string;
  short: string;
  blurb: string;
  hfQueries: string[];
  hfFilters: string[];
  ghQueries: string[];
  atlas: HarvestItem[];
};

function splitId(id: string): { owner: string; name: string } {
  const i = id.indexOf("/");
  if (i <= 0) return { owner: "", name: id };
  return { owner: id.slice(0, i), name: id.slice(i + 1) };
}

function ds(
  id: string,
  expert: ExpertId,
  description: string,
  extra?: Partial<HarvestItem>,
): HarvestItem {
  const { owner, name } = splitId(id);
  return {
    id,
    source: "huggingface",
    kind: "dataset",
    name,
    owner,
    url: `https://huggingface.co/datasets/${id}`,
    description,
    expert,
    tags: extra?.tags ?? [],
    license: extra?.license ?? null,
    downloads: extra?.downloads ?? null,
    likes: extra?.likes ?? null,
    stars: null,
    language: extra?.language ?? null,
    lastModified: extra?.lastModified ?? null,
    gated: extra?.gated ?? false,
    origin: "atlas",
  };
}

function repo(
  id: string,
  expert: ExpertId,
  description: string,
  extra?: Partial<HarvestItem>,
): HarvestItem {
  const { owner, name } = splitId(id);
  return {
    id,
    source: "github",
    kind: "repo",
    name,
    owner: owner || id,
    url: `https://github.com/${id}`,
    description,
    expert,
    tags: extra?.tags ?? [],
    license: extra?.license ?? extra?.language ?? null,
    downloads: null,
    likes: null,
    stars: extra?.stars ?? null,
    language: extra?.language ?? null,
    lastModified: extra?.lastModified ?? null,
    gated: false,
    origin: "atlas",
  };
}

export const EXPERTS: ExpertDef[] = [
  {
    id: "code",
    name: "Code & agents",
    short: "Code",
    blurb: "Instruction code, tools, compilers, agent traces.",
    hfQueries: ["code instruction", "coding agents", "the stack"],
    hfFilters: ["task_categories:text-generation"],
    ghQueries: [
      "topic:llm stars:>2000",
      "topic:agents stars:>1000",
      "llama.cpp OR vllm stars:>3000",
    ],
    atlas: [
      ds("HuggingFaceH4/CodeAlpaca_20K", "code", "Code instruction pairs for small-model SFT."),
      ds("bigcode/commitpackft", "code", "Commit-message to code diffs — edit habits."),
      ds("nvidia/OpenCodeInstruct", "code", "Large open code-instruct mix."),
      ds("OpenCoder-LLM/opc-sft-stage1", "code", "OpenCoder stage-1 SFT corpus."),
      repo("ggml-org/llama.cpp", "code", "Local GGUF runtime — runs open models on consumer hardware.", {
        language: "C++",
      }),
      repo("vllm-project/vllm", "code", "High-throughput local/server inference.", {
        language: "Python",
      }),
      repo("huggingface/transformers", "code", "Model hub client and train surface.", {
        language: "Python",
      }),
    ],
  },
  {
    id: "math",
    name: "Math & reason",
    short: "Math",
    blurb: "GSM, olympiads, step-by-step collapse.",
    hfQueries: ["gsm8k", "math reasoning", "olympiad"],
    hfFilters: [],
    ghQueries: ["topic:mathematics stars:>500", "gsm8k OR math-eval stars:>200"],
    atlas: [
      ds("openai/gsm8k", "math", "Grade-school math word problems — classic reason set."),
      ds("EleutherAI/hendrycks_math", "math", "MATH competition problems by subject."),
      ds("HuggingFaceH4/MATH-500", "math", "500-item MATH eval slice."),
      ds("nvidia/OpenMathInstruct-2", "math", "Synthetic math instruct at scale."),
    ],
  },
  {
    id: "science",
    name: "Science",
    short: "Science",
    blurb: "Papers, methods, biomedical and physics text.",
    hfQueries: ["scientific papers", "pubmed", "arxiv"],
    hfFilters: [],
    ghQueries: ["topic:science stars:>1000 pushed:>2026-01-01"],
    atlas: [
      ds("allenai/peS2o", "science", "S2ORC-derived scientific papers for language models."),
      ds("scientific_papers", "science", "ArXiv + PubMed summarization pairs."),
      repo("nomic-ai/gpt4all", "science", "Open local assistant stack and data notes.", {
        language: "C++",
      }),
    ],
  },
  {
    id: "language",
    name: "Language",
    short: "Lang",
    blurb: "Chat, instruct, multilingual mouths.",
    hfQueries: ["ultrachat", "openhermes", "instruction chat"],
    hfFilters: ["task_categories:text-generation"],
    ghQueries: ["topic:instruction-tuning stars:>400"],
    atlas: [
      ds("HuggingFaceH4/ultrachat_200k", "language", "Cleaned UltraChat — general instruct mouth."),
      ds("teknium/OpenHermes-2.5", "language", "High-signal open instruct mix."),
      ds("Open-Orca/OpenOrca", "language", "Explanation-style instruct traces."),
      ds("lmsys/lmsys-chat-1m", "language", "Real chat traffic — diverse user intents."),
    ],
  },
  {
    id: "vision",
    name: "Vision",
    short: "Vision",
    blurb: "Image-text, VQA, Observatory-adjacent.",
    hfQueries: ["image caption", "visual question", "vlm"],
    hfFilters: ["task_categories:image-text-to-text"],
    ghQueries: ["topic:computer-vision stars:>2000", "topic:multimodal stars:>1000"],
    atlas: [
      ds("HuggingFaceM4/the_cauldron", "vision", "Many vision-language tasks in one mix."),
      ds("lmms-lab/LLaVA-NeXT-Data", "vision", "LLaVA-style visual instruction."),
      ds("google/docci", "vision", "Dense image captions."),
      repo("haotian-liu/LLaVA", "vision", "Visual instruction baseline.", { language: "Python" }),
    ],
  },
  {
    id: "audio",
    name: "Audio",
    short: "Audio",
    blurb: "Speech, ASR, TTS — live mouth and cams.",
    hfQueries: ["speech asr", "tts", "librispeech"],
    hfFilters: ["task_categories:automatic-speech-recognition"],
    ghQueries: ["topic:speech-recognition stars:>800", "whisper OR piper stars:>1000"],
    atlas: [
      ds("mozilla-foundation/common_voice_17_0", "audio", "Multilingual read speech, versioned."),
      ds("openslr/librispeech_asr", "audio", "Classic clean/other ASR benchmark."),
      ds("google/fleurs", "audio", "Few-shot speech across many languages."),
      repo("openai/whisper", "audio", "Robust ASR encoder used as a field sensor.", {
        language: "Python",
      }),
    ],
  },
  {
    id: "medical",
    name: "Medical",
    short: "Med",
    blurb: "Public clinical and bio — never private PHI.",
    hfQueries: ["medical qa", "clinical public", "pubmed"],
    hfFilters: [],
    ghQueries: ["topic:healthcare stars:>500 license:mit"],
    atlas: [
      ds("medalpaca/medical_meadow_medqa", "medical", "USMLE-style public medical QA."),
      ds("GBaker/MedQA-USMLE-4-options", "medical", "Four-option medical exam items."),
      ds("pubmed_qa", "medical", "Biomedical QA from abstracts — public only."),
    ],
  },
  {
    id: "law",
    name: "Law & GRC",
    short: "Law",
    blurb: "Statutes, contracts, compliance language.",
    hfQueries: ["legal contract", "law case", "compliance"],
    hfFilters: [],
    ghQueries: ["topic:legal-nlp stars:>200"],
    atlas: [
      ds("pile-of-law/pile-of-law", "law", "Broad US legal text — court, docket, regs."),
      ds("lexlms/legal_statutes", "law", "Statute-style legal language."),
      ds("nguha/legalbench", "law", "Legal reasoning tasks and probes."),
    ],
  },
  {
    id: "knowledge",
    name: "Knowledge",
    short: "KR",
    blurb: "Retrieval, wiki, RAG — KR gold fuel.",
    hfQueries: ["wikipedia retrieval", "rag", "hotpotqa"],
    hfFilters: ["task_categories:question-answering"],
    ghQueries: ["topic:rag stars:>800", "topic:retrieval stars:>1000"],
    atlas: [
      ds("wikimedia/wikipedia", "knowledge", "Living Wikipedia dumps by language."),
      ds("hotpot_qa", "knowledge", "Multi-hop retrieval questions."),
      ds("BeIR/nq", "knowledge", "Natural Questions retrieval split."),
      repo("facebookresearch/faiss", "knowledge", "Vector index used in field search.", {
        language: "C++",
      }),
    ],
  },
  {
    id: "safety",
    name: "Safety",
    short: "Safety",
    blurb: "Preference, hold, red-team — Sentinel fuel.",
    hfQueries: ["hh-rlhf", "dpo preference", "safety refusal"],
    hfFilters: [],
    ghQueries: ["topic:ai-safety stars:>400", "red-team OR jailbreak dataset stars:>100"],
    atlas: [
      ds("Anthropic/hh-rlhf", "safety", "Helpful/harmless preference pairs."),
      ds("HuggingFaceH4/ultrafeedback_binarized", "safety", "Binarized preference for DPO."),
      ds("allenai/real-toxicity-prompts", "safety", "Toxicity hold probes."),
      ds("PKU-Alignment/PKU-SafeRLHF", "safety", "Safety preference with severity tags."),
    ],
  },
  {
    id: "affect",
    name: "Affect",
    short: "Affect",
    blurb: "Emotion, dialogue tone — PAD-adjacent mouths.",
    hfQueries: ["emotion classification", "empathetic dialogue", "sentiment"],
    hfFilters: ["task_categories:text-classification"],
    ghQueries: ["topic:emotion stars:>300", "dialogue-emotion stars:>100"],
    atlas: [
      ds("dair-ai/emotion", "affect", "Twitter emotion labels — six classes."),
      ds("empathetic_dialogues", "affect", "Empathetic response pairs."),
      ds("google-research-datasets/go_emotions", "affect", "Fine-grained Reddit emotions."),
      ds("daily_dialog", "affect", "Multi-turn daily conversation with act/emotion."),
    ],
  },
  {
    id: "systems",
    name: "Systems",
    short: "Sys",
    blurb: "Robotics, time series, control, sensors.",
    hfQueries: ["robotics", "time series forecasting", "control"],
    hfFilters: [],
    ghQueries: [
      "topic:robotics stars:>1500",
      "topic:ros2 stars:>400",
      "topic:time-series stars:>800",
    ],
    atlas: [
      ds("monash_tsf", "systems", "Monash time-series forecasting archive."),
      ds("sktime/pca-tsc", "systems", "Time-series classification pack."),
      repo("ros2/ros2", "systems", "ROS 2 meta — open robotics middleware.", {
        language: "Python",
      }),
      repo("huggingface/lerobot", "systems", "Open robotics datasets + policies.", {
        language: "Python",
      }),
    ],
  },
];

export const EXPERT_BY_ID: Record<ExpertId, ExpertDef> = Object.fromEntries(
  EXPERTS.map((e) => [e.id, e]),
) as Record<ExpertId, ExpertDef>;

export const ALL_ATLAS: HarvestItem[] = (() => {
  const map = new Map<string, HarvestItem>();
  for (const it of EXPERTS.flatMap((e) => e.atlas)) {
    if (!map.has(it.id)) map.set(it.id, it);
  }
  return Array.from(map.values());
})();

export function expertForTags(
  text: string,
  tags: string[],
  fallback: ExpertId = "language",
): ExpertId {
  const blob = `${text} ${tags.join(" ")}`.toLowerCase();
  const rules: Array<[ExpertId, string[]]> = [
    ["code", ["code", "programming", "python", "javascript", "agent", "compiler", "stack"]],
    ["math", ["math", "gsm", "algebra", "geometry", "reasoning", "olympiad"]],
    ["science", ["arxiv", "pubmed", "paper", "physics", "chemistry", "biology"]],
    ["vision", ["image", "vision", "vlm", "caption", "vqa", "multimodal"]],
    ["audio", ["audio", "speech", "asr", "tts", "whisper", "voice"]],
    ["medical", ["medical", "clinical", "medqa", "usmle", "patient"]],
    ["law", ["legal", "law", "contract", "statute", "court"]],
    ["knowledge", ["wikipedia", "retrieval", "rag", "hotpot", "nq"]],
    ["safety", ["safety", "rlhf", "preference", "dpo", "toxicity", "jailbreak"]],
    ["affect", ["emotion", "sentiment", "empath", "dialogue", "affect"]],
    ["systems", ["robot", "ros", "timeseries", "time-series", "control", "sensor"]],
    ["language", ["instruct", "chat", "ultrachat", "conversation", "language"]],
  ];
  for (const [id, keys] of rules) {
    if (keys.some((k) => blob.includes(k))) return id;
  }
  return fallback;
}
