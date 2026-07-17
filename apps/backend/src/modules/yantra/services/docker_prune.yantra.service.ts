import { logger } from "@backend/utils/logger.utils";
import Docker from "dockerode";

/**
 * Self-maintaining disk reclaim (operator 2026-07-13: "the system should be
 * self-maintaining — why do I have to SSH?"). Every ensemble run clones the
 * repo and does a full `yarn install` inside its container, and every staging
 * deploy builds a fresh app image; the replaced images go dangling and the
 * build cache grows without bound. Left alone the VPS disk fills and new
 * containers die at `yarn install` with ENOSPC — which is exactly what took the
 * factory down on 2026-07-14.
 *
 * The backend already holds the Docker socket (it spawns every run container),
 * so it can reclaim space through that same socket — no host access. This prune
 * is deliberately SAFE: stopped containers, DANGLING (untagged) images, and
 * build cache only. It never touches tagged images (the exec image, the app
 * image) and never touches volumes — the Postgres data volume is a Docker
 * volume, so pruning volumes would wipe the database. Those are hard exclusions.
 */

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export interface PruneResult {
	ok: boolean;
	/** Total bytes reclaimed across containers + dangling images + build cache. */
	reclaimedBytes: number;
	containersDeleted: number;
	imagesDeleted: number;
	/** Human-readable reclaimed size, e.g. "3.4 GB". */
	reclaimedHuman: string;
	error: string | null;
}

/** Pure: bytes → short human string (base-1000, matches `docker system df`). */
export const humanBytes = (n: number): string => {
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	const units = ["B", "kB", "MB", "GB", "TB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
	const v = n / 1000 ** i;
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/**
 * Pure: fold the three dockerode prune responses into one PruneResult. Kept
 * separate from the socket calls so the arithmetic is unit-testable without a
 * daemon. Any missing field counts as zero (dockerode omits empty arrays).
 */
export const summarizePrune = (
	containers: { ContainersDeleted?: string[] | null; SpaceReclaimed?: number },
	images: { ImagesDeleted?: unknown[] | null; SpaceReclaimed?: number },
	buildCache: { SpaceReclaimed?: number },
): PruneResult => {
	const reclaimedBytes =
		(containers.SpaceReclaimed ?? 0) +
		(images.SpaceReclaimed ?? 0) +
		(buildCache.SpaceReclaimed ?? 0);
	return {
		ok: true,
		reclaimedBytes,
		containersDeleted: containers.ContainersDeleted?.length ?? 0,
		imagesDeleted: images.ImagesDeleted?.length ?? 0,
		reclaimedHuman: humanBytes(reclaimedBytes),
		error: null,
	};
};

/**
 * Reclaim disk through the Docker socket: stopped containers + dangling images
 * + build cache. Never volumes, never tagged images. Safe to run on a live
 * host — nothing in use is removed.
 */
export const pruneDocker = async (): Promise<PruneResult> => {
	try {
		// Stopped containers first (frees their writable layers so the dangling
		// image prune underneath can reclaim the parent layers too).
		const containers = await docker.pruneContainers();
		// No filter ⇒ dangling (untagged) images only. Replaced app/exec images
		// go untagged on rebuild, so this reclaims the deploy bloat while leaving
		// the current tagged images in place.
		const images = await docker.pruneImages();
		// dockerode types pruneBuildCache loosely; the daemon returns SpaceReclaimed.
		const buildCache = (await (
			docker as unknown as {
				pruneBuildCache: () => Promise<{ SpaceReclaimed?: number }>;
			}
		).pruneBuildCache()) ?? { SpaceReclaimed: 0 };

		const result = summarizePrune(containers, images, buildCache);
		logger.info(
			{ reclaimed: result.reclaimedHuman, images: result.imagesDeleted },
			"yantra docker prune finished",
		);
		return result;
	} catch (err) {
		const msg =
			err instanceof Error ? err.message.slice(0, 200) : "prune failed";
		logger.warn({ err }, "yantra docker prune failed");
		return {
			ok: false,
			reclaimedBytes: 0,
			containersDeleted: 0,
			imagesDeleted: 0,
			reclaimedHuman: "0 B",
			error: msg,
		};
	}
};
