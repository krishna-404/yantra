import {
	type AppSecretKey,
	getAppSecretValue,
} from "@backend/modules/yantra/services/app_secrets.yantra.service";

/**
 * Phase 3 lane registry (L2) + smoke check (L5). A "lane" is a cheap/free
 * model provider the OpenCode runner can drive for T0/T1 work; Claude stays
 * the lane for advise/grade always. This file is the single source of truth
 * for lane endpoints — the runner and the router both read it.
 *
 * The smoke check hits each provider's model-list endpoint: it proves the
 * stored key is valid and enumerates reachable models, at zero token cost and
 * without guessing a model name. Providers differ in how the key is passed
 * (bearer header vs query param) — encoded per lane.
 */

export interface Lane {
	/** Stable registry id (used in telemetry lane column + routing). */
	id: string;
	label: string;
	/** Which app-secret holds this lane's API key. */
	secretKey: AppSecretKey;
	/** OpenAI-style model-list endpoint (or provider equivalent). */
	modelsUrl: string;
	/** How the API key is presented. */
	auth: "bearer" | "query";
}

export const LANES: Lane[] = [
	{
		id: "nvidia",
		label: "NVIDIA",
		secretKey: "NVIDIA_API_KEY",
		modelsUrl: "https://integrate.api.nvidia.com/v1/models",
		auth: "bearer",
	},
	{
		id: "groq",
		label: "Groq",
		secretKey: "GROQ_API_KEY",
		modelsUrl: "https://api.groq.com/openai/v1/models",
		auth: "bearer",
	},
	{
		id: "gemini",
		label: "Gemini",
		secretKey: "GEMINI_API_KEY",
		modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
		auth: "query",
	},
];

export interface LaneSmokeResult {
	lane: string;
	keyPresent: boolean;
	ok: boolean;
	modelCount: number;
	sampleModel: string | null;
	latencyMs: number;
	error: string | null;
}

/** Shape both OpenAI-style (`data[].id`) and Gemini-style (`models[].name`). */
const extractModels = (body: unknown): { id: string }[] => {
	if (!body || typeof body !== "object") return [];
	const b = body as { data?: unknown; models?: unknown };
	const list = Array.isArray(b.data)
		? b.data
		: Array.isArray(b.models)
			? b.models
			: [];
	return list
		.map((m) => {
			const item = m as { id?: unknown; name?: unknown };
			const id = typeof item.id === "string" ? item.id : item.name;
			return typeof id === "string" ? { id } : null;
		})
		.filter((x): x is { id: string } => x !== null);
};

/** Verify a lane's stored key works by listing its models. No token cost. */
export const runLaneSmoke = async (
	laneId: string,
): Promise<LaneSmokeResult> => {
	const lane = LANES.find((l) => l.id === laneId);
	if (!lane) throw new Error(`unknown lane: ${laneId}`);

	const base: LaneSmokeResult = {
		lane: laneId,
		keyPresent: false,
		ok: false,
		modelCount: 0,
		sampleModel: null,
		latencyMs: 0,
		error: null,
	};

	const apiKey = await getAppSecretValue(lane.secretKey);
	if (!apiKey) return { ...base, error: "no key set for this lane" };

	const started = Date.now();
	try {
		const url =
			lane.auth === "query"
				? `${lane.modelsUrl}?key=${encodeURIComponent(apiKey)}`
				: lane.modelsUrl;
		const res = await fetch(url, {
			headers:
				lane.auth === "bearer" ? { authorization: `Bearer ${apiKey}` } : {},
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			return {
				...base,
				keyPresent: true,
				latencyMs,
				error: `provider returned HTTP ${res.status}`,
			};
		}
		const models = extractModels(await res.json());
		return {
			lane: laneId,
			keyPresent: true,
			ok: models.length > 0,
			modelCount: models.length,
			sampleModel: models[0]?.id ?? null,
			latencyMs,
			error: models.length === 0 ? "key valid but no models listed" : null,
		};
	} catch (err) {
		return {
			...base,
			keyPresent: true,
			latencyMs: Date.now() - started,
			error:
				err instanceof Error ? err.message.slice(0, 200) : "request failed",
		};
	}
};

export interface LaneView {
	id: string;
	label: string;
	keyPresent: boolean;
}

/** Registry + whether each lane's key is stored (never the key itself). */
export const listLanes = async (): Promise<LaneView[]> => {
	const results = await Promise.all(
		LANES.map(async (l) => ({
			id: l.id,
			label: l.label,
			keyPresent: (await getAppSecretValue(l.secretKey)) !== null,
		})),
	);
	return results;
};

// ── model catalog (Phase 3, D26) ────────────────────────────────────────────
// "Different models for different tasks": fast models execute (many tool
// calls, latency matters); strong-but-slow models grade (quality matters,
// latency tolerated). This seed is the STARTING pool — the scorecards + nightly
// catalog-diff refine it: retired models (e.g. the Qwen coder EOL'd 2026-05-12)
// drop out, new ones enter once they have a few graded runs. Planning/grading
// never run on the model that wrote the code (no self-grading); a strong FREE
// model may grade, audited periodically by Claude (D26).

export type LaneRole = "execute" | "grade";
export type LaneSource = "groq" | "nvidia" | "opencode";

export interface LaneModel {
	/** OpenCode model ref `provider/model`, e.g. "nvidia/qwen/qwen3-coder-480b-a35b-instruct". */
	ref: string;
	label: string;
	/** "nvidia" uses NVIDIA_API_KEY; "opencode" uses the OpenCode login token. */
	source: LaneSource;
	roles: LaneRole[];
	/** Pre-scorecard speed hint — a tie-breaker only until real timing data exists. */
	speed: "fast" | "medium" | "slow";
}

export const LANE_MODELS: LaneModel[] = [
	// Groq executors first — 280–1000 t/s (vs NVIDIA's MoE models hanging inside
	// opencode). gpt-oss are OpenAI open-weight models strong at code; listed
	// fastest-first so the default top-3 pick is all Groq when its key is set.
	{
		ref: "groq/openai/gpt-oss-120b",
		label: "GPT-OSS 120B (Groq)",
		source: "groq",
		roles: ["execute"],
		speed: "fast",
	},
	{
		ref: "groq/openai/gpt-oss-20b",
		label: "GPT-OSS 20B (Groq)",
		source: "groq",
		roles: ["execute"],
		speed: "fast",
	},
	{
		ref: "groq/llama-3.3-70b-versatile",
		label: "Llama 3.3 70B (Groq)",
		source: "groq",
		roles: ["execute"],
		speed: "fast",
	},
	// Groq grader — distinct from the executors above (no self-grading, D26).
	{
		ref: "groq/qwen/qwen3-32b",
		label: "Qwen3 32B (Groq)",
		source: "groq",
		roles: ["grade"],
		speed: "medium",
	},
	// executors — fast enough to drive many tool calls
	{
		ref: "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
		label: "Qwen3 Coder 480B (MoE)",
		source: "nvidia",
		roles: ["execute"],
		speed: "medium",
	},
	{
		ref: "nvidia/deepseek-ai/deepseek-v4-flash",
		label: "DeepSeek V4 Flash",
		source: "nvidia",
		roles: ["execute"],
		speed: "fast",
	},
	{
		ref: "nvidia/meta/llama-3.3-70b-instruct",
		label: "Llama 3.3 70B",
		source: "nvidia",
		roles: ["execute"],
		speed: "medium",
	},
	// graders — strongest available; latency tolerated
	{
		ref: "nvidia/qwen/qwen3.5-397b-a17b",
		label: "Qwen3.5 397B (MoE)",
		source: "nvidia",
		roles: ["grade"],
		speed: "slow",
	},
	{
		ref: "nvidia/deepseek-ai/deepseek-v4-pro",
		label: "DeepSeek V4 Pro",
		source: "nvidia",
		roles: ["grade"],
		speed: "slow",
	},
	{
		ref: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
		label: "Nemotron 3 Ultra 550B",
		source: "nvidia",
		roles: ["grade"],
		speed: "slow",
	},
	// OpenCode-native free models — enabled once the OpenCode token is stored
	{
		ref: "opencode/deepseek-v4-flash-free",
		label: "DeepSeek V4 Flash (OpenCode free)",
		source: "opencode",
		roles: ["execute"],
		speed: "fast",
	},
	{
		ref: "opencode/north-mini-code-free",
		label: "North Mini Code (OpenCode free)",
		source: "opencode",
		roles: ["execute"],
		speed: "fast",
	},
	{
		ref: "opencode/nemotron-3-ultra-free",
		label: "Nemotron 3 Ultra (OpenCode free)",
		source: "opencode",
		roles: ["grade"],
		speed: "slow",
	},
];

/** Candidate models for a role, limited to sources whose credential is present. */
export const candidateModels = (
	role: LaneRole,
	availableSources: LaneSource[],
): LaneModel[] =>
	LANE_MODELS.filter(
		(m) => m.roles.includes(role) && availableSources.includes(m.source),
	);

/**
 * Which free providers are configured right now: the keys to inject into the
 * run container (opencode.json reads them via {env:…}) and the sources to draw
 * candidates from. Groq first — it's the fastest and the catalog lists it first,
 * so the default top-3 executor pick is all Groq when its key is set.
 */
export const resolveFreeProviders = async (): Promise<{
	providerKeys: Record<string, string>;
	sources: LaneSource[];
}> => {
	const providerKeys: Record<string, string> = {};
	const sources: LaneSource[] = [];
	const groq = await getAppSecretValue("GROQ_API_KEY");
	if (groq) {
		providerKeys.GROQ_API_KEY = groq;
		sources.push("groq");
	}
	const nvidia = await getAppSecretValue("NVIDIA_API_KEY");
	if (nvidia) {
		providerKeys.NVIDIA_API_KEY = nvidia;
		sources.push("nvidia");
	}
	return { providerKeys, sources };
};
