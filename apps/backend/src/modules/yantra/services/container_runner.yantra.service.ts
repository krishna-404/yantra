import { EXEC_IMAGE } from "@backend/modules/yantra/services/docker_status.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import Docker from "dockerode";

/**
 * Spawns one yantra-exec container per run (loop-protocol §7, D18 caps:
 * ≤3 parallel, 4 GB RAM, 2 CPUs each). The script arrives as SCRIPT_B64 env
 * and runs under bash — the exact contract v0's `docker run … bash -s`
 * heredocs had, minus stdin. Tty merges stderr into stdout so logs read as
 * one transcript, again matching v0's `2>&1` capture.
 */

const RUN_LABEL = "yantra-run";
const MAX_PARALLEL_RUNS = 3; // D18
const MEMORY_BYTES = 4 * 1024 * 1024 * 1024; // 4g
const NANO_CPUS = 2_000_000_000; // 2 cpus

export interface ContainerRunResult {
	exitCode: number;
	/** Combined stdout+stderr transcript (Tty). */
	output: string;
	timedOut: boolean;
}

export class RunnerAtCapacityError extends Error {
	constructor() {
		super(`already ${MAX_PARALLEL_RUNS} yantra runs in flight (D18)`);
	}
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const runningYantraContainers = async (): Promise<number> => {
	const list = await docker.listContainers({
		filters: { label: [`${RUN_LABEL}=1`] },
	});
	return list.length;
};

export const runYantraContainer = async (opts: {
	name: string; // e.g. "yantra-advise-72-<ulid>"
	script: string; // bash source, becomes SCRIPT_B64
	env: Record<string, string>;
	timeoutMs: number;
	/** Container image — defaults to the Claude exec image; free lanes pass the OpenCode one. */
	image?: string;
}): Promise<ContainerRunResult> => {
	if ((await runningYantraContainers()) >= MAX_PARALLEL_RUNS) {
		throw new RunnerAtCapacityError();
	}

	const envArray = [
		...Object.entries(opts.env).map(([k, v]) => `${k}=${v}`),
		`SCRIPT_B64=${Buffer.from(opts.script, "utf8").toString("base64")}`,
	];

	const container = await docker.createContainer({
		Image: opts.image ?? EXEC_IMAGE,
		name: opts.name,
		Cmd: ["bash", "-c", 'echo "$SCRIPT_B64" | base64 -d | bash'],
		Env: envArray,
		Tty: true,
		Labels: { [RUN_LABEL]: "1" },
		HostConfig: {
			Memory: MEMORY_BYTES,
			NanoCpus: NANO_CPUS,
			NetworkMode: "bridge",
		},
	});

	let timedOut = false;
	const killTimer = setTimeout(() => {
		timedOut = true;
		container.kill().catch(() => {
			/* already gone */
		});
	}, opts.timeoutMs);

	try {
		await container.start();
		const wait = (await container.wait()) as { StatusCode: number };
		const logBuf = (await container.logs({
			stdout: true,
			stderr: true,
		})) as unknown as Buffer;
		return {
			exitCode: timedOut ? 124 : wait.StatusCode,
			output: logBuf.toString("utf8"),
			timedOut,
		};
	} finally {
		clearTimeout(killTimer);
		await container.remove({ force: true }).catch((err) => {
			logger.warn({ err, name: opts.name }, "yantra container remove failed");
		});
	}
};
