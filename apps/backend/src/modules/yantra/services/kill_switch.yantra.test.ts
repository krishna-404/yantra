import { db } from "@backend/db/db";
import {
	getKillSwitch,
	setKillSwitch,
} from "@backend/modules/yantra/services/kill_switch.yantra.service";
import { addProject } from "@backend/modules/yantra/services/projects.yantra.service";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The red button: reads/PATCHes YANTRA_KILL with the project's own token. */

const realFetch = globalThis.fetch;
afterEach(async () => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
	await db.yantraProjects.where({ repo: "ks-owner/ks-repo" }).delete();
});

const TOKEN = "ghp_killswitch_test_token_0000000000_FAKE";

const makeProject = () =>
	addProject({
		repo: "ks-owner/ks-repo",
		baseBranch: "staging",
		ghToken: TOKEN,
	});

describe("kill switch service", () => {
	it("reads the variable with the project token; unreadable ⇒ null (fails closed upstream)", async () => {
		const project = await makeProject();
		let auth: string | null = null;
		globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
			auth = new Headers((init as RequestInit)?.headers).get("authorization");
			expect(String(url)).toContain(
				"/repos/ks-owner/ks-repo/actions/variables/YANTRA_KILL",
			);
			return new Response(JSON.stringify({ value: "false" }), { status: 200 });
		}) as unknown as typeof fetch;

		const state = await getKillSwitch(project.id);
		expect(state.kill).toBe(false);
		expect(state.repo).toBe("ks-owner/ks-repo");
		expect(auth).toBe(`Bearer ${TOKEN}`);

		globalThis.fetch = vi.fn(
			async () => new Response("no", { status: 403 }),
		) as unknown as typeof fetch;
		expect((await getKillSwitch(project.id)).kill).toBeNull();
	});

	it("setKillSwitch PATCHes the variable and echoes the new state", async () => {
		const project = await makeProject();
		let body: unknown = null;
		let method: string | undefined;
		globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
			const req = init as RequestInit;
			method = req?.method;
			body = JSON.parse(String(req?.body ?? "null"));
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;

		const state = await setKillSwitch(project.id, true);
		expect(method).toBe("PATCH");
		expect(body).toEqual({ name: "YANTRA_KILL", value: "true" });
		expect(state.kill).toBe(true);
	});
});
