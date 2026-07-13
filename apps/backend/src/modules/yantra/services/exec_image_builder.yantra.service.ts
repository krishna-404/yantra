import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXEC_IMAGE_OC } from "@backend/modules/yantra/services/docker_status.yantra.service";
import { fetchRepoFile } from "@backend/modules/yantra/services/repo_files.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import Docker from "dockerode";

/**
 * Self-maintaining runner image (operator 2026-07-13: "the system should be
 * self-maintaining — why do I have to SSH?"). The OpenCode run image bakes in
 * ops/yantra/oc/{Dockerfile,opencode.json}, so a config change (e.g. adding the
 * Groq provider) used to need a manual `docker build` on the VPS.
 *
 * The backend already holds the Docker socket (it spawns every run container),
 * so it can build this image through that same socket — no host access. We
 * fetch the two build files from the repo (via the project token, so it always
 * matches the deployed branch), write them to a temp context, and build.
 */

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export interface ImageBuildResult {
	ok: boolean;
	tag: string;
	/** Tail of the build transcript (or the error). */
	log: string;
}

/** Pure: did the build stream end in a tagged image and no error? */
export const buildSucceeded = (log: string): boolean => {
	const named = /(successfully built|writing image|naming to)/i.test(log);
	const errored = /\berror\b/i.test(log.slice(-800));
	return named && !errored;
};

export const buildExecImage = async (input: {
	repo: string;
	baseBranch: string;
	ghToken: string;
}): Promise<ImageBuildResult> => {
	const [dockerfile, opencodeJson] = await Promise.all([
		fetchRepoFile(
			input.repo,
			"ops/yantra/oc/Dockerfile",
			input.baseBranch,
			input.ghToken,
		),
		fetchRepoFile(
			input.repo,
			"ops/yantra/oc/opencode.json",
			input.baseBranch,
			input.ghToken,
		),
	]);
	if (!dockerfile || !opencodeJson) {
		return {
			ok: false,
			tag: EXEC_IMAGE_OC,
			log: "could not fetch ops/yantra/oc/{Dockerfile,opencode.json} from the repo",
		};
	}

	const dir = await mkdtemp(join(tmpdir(), "yantra-oc-build-"));
	try {
		await writeFile(join(dir, "Dockerfile"), dockerfile);
		await writeFile(join(dir, "opencode.json"), opencodeJson);

		const stream = await docker.buildImage(
			{ context: dir, src: ["Dockerfile", "opencode.json"] },
			{ t: EXEC_IMAGE_OC, forcerm: true },
		);

		const log = await new Promise<string>((resolve, reject) => {
			let out = "";
			docker.modem.followProgress(
				stream,
				(err) => (err ? reject(err) : resolve(out)),
				(evt: { stream?: string; error?: string }) => {
					if (evt.stream) out += evt.stream;
					if (evt.error) out += `ERROR: ${evt.error}`;
				},
			);
		});

		const ok = buildSucceeded(log);
		logger.info({ ok, tag: EXEC_IMAGE_OC }, "yantra exec image build finished");
		return { ok, tag: EXEC_IMAGE_OC, log: log.slice(-2000) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ err }, "yantra exec image build failed");
		return { ok: false, tag: EXEC_IMAGE_OC, log: msg.slice(-2000) };
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
};
