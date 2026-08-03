import {
	type AppSecretKey,
	getAppSecretValue,
} from "@backend/modules/yantra/services/app_secrets.yantra.service";

/**
 * Direct free-provider text completion (Phase 3). Some harness steps are pure
 * text — grooming a rough idea into a spec, later scoring a diff — and need no
 * repo, no container, no tools. For those, a single OpenAI-compatible chat
 * call is far cheaper and faster than spawning an OpenCode container.
 *
 * This is deliberately separate from the OpenCode lane (which drives coding
 * agents in containers): here we just want one model's text answer. Providers
 * are the same free ones the ensemble uses, keyed off the same app-secrets.
 */

export interface CompletionProvider {
	id: string;
	label: string;
	secretKey: AppSecretKey;
	/** OpenAI-compatible chat-completions endpoint. */
	chatUrl: string;
	/** A sensible default model for text grooming (fast, instruction-following). */
	defaultModel: string;
}

// OpenAI-compatible providers only (single request shape). Gemini's native API
// differs; it joins once we need it here.
/** Ceiling for one provider attempt; the next provider in the chain gets a turn. */
const COMPLETION_TIMEOUT_MS = 120_000;

export const COMPLETION_PROVIDERS: CompletionProvider[] = [
	{
		id: "groq",
		label: "Groq",
		secretKey: "GROQ_API_KEY",
		chatUrl: "https://api.groq.com/openai/v1/chat/completions",
		defaultModel: "llama-3.3-70b-versatile",
	},
	{
		id: "nvidia",
		label: "NVIDIA",
		secretKey: "NVIDIA_API_KEY",
		chatUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
		defaultModel: "meta/llama-3.3-70b-instruct",
	},
];

export interface FreeCompletionResult {
	provider: string;
	model: string;
	text: string;
	latencyMs: number;
}

/**
 * First provider whose key is set wins (Groq first — fastest observed). Throws
 * only if NO provider has a key, or the chosen provider errors.
 */
export const freeComplete = async (input: {
	system: string;
	user: string;
	/** 0..1; grooming wants low temperature for structured, faithful output. */
	temperature?: number;
	maxTokens?: number;
	/** Force a specific provider id; otherwise first-with-key wins. */
	providerId?: string;
}): Promise<FreeCompletionResult> => {
	const ordered = input.providerId
		? COMPLETION_PROVIDERS.filter((p) => p.id === input.providerId)
		: COMPLETION_PROVIDERS;

	let firstErr: string | null = null;
	for (const provider of ordered) {
		const key = await getAppSecretValue(provider.secretKey);
		if (!key) continue;
		const started = Date.now();
		try {
			const res = await fetch(provider.chatUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${key}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: provider.defaultModel,
					temperature: input.temperature ?? 0.2,
					max_tokens: input.maxTokens ?? 2000,
					messages: [
						{ role: "system", content: input.system },
						{ role: "user", content: input.user },
					],
				}),
				// Generous — these are real completions — but bounded. This runs
				// inside chat's sendMessage and the routines sweep; an unbounded
				// hang blocks a user's request or the whole sweep behind it.
				signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
			});
			if (!res.ok) {
				firstErr ??= `${provider.id}: HTTP ${res.status}`;
				continue;
			}
			const body = (await res.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const text = body.choices?.[0]?.message?.content?.trim();
			if (!text) {
				firstErr ??= `${provider.id}: empty completion`;
				continue;
			}
			return {
				provider: provider.id,
				model: provider.defaultModel,
				text,
				latencyMs: Date.now() - started,
			};
		} catch (err) {
			firstErr ??=
				err instanceof Error ? `${provider.id}: ${err.message}` : provider.id;
		}
	}
	throw new Error(firstErr ?? "no free completion provider has a key set");
};
