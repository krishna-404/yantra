import Docker from "dockerode";

/**
 * H5 pre-flight: is the host's Docker daemon reachable through the socket
 * mount? The execute runner spawns yantra-exec containers via this socket;
 * the cockpit shows this so the operator can verify the Dokploy bind mount
 * (/var/run/docker.sock) actually landed after a redeploy.
 */

export interface DockerStatus {
	reachable: boolean;
	version: string | null;
	execImagePresent: boolean;
	error: string | null;
}

export const EXEC_IMAGE = "yantra-exec:0";

export const getDockerStatus = async (): Promise<DockerStatus> => {
	const docker = new Docker({ socketPath: "/var/run/docker.sock" });
	try {
		const version = await docker.version();
		let execImagePresent = false;
		try {
			await docker.getImage(EXEC_IMAGE).inspect();
			execImagePresent = true;
		} catch {
			execImagePresent = false;
		}
		return {
			reachable: true,
			version: version.Version ?? "unknown",
			execImagePresent,
			error: null,
		};
	} catch (err) {
		return {
			reachable: false,
			version: null,
			execImagePresent: false,
			error: err instanceof Error ? err.message.slice(0, 200) : "unreachable",
		};
	}
};
