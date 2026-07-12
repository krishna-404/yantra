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
