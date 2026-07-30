import {
	humanBytes,
	summarizePrune,
} from "@backend/modules/yantra/services/docker_prune.yantra.service";
import { describe, expect, it } from "vitest";

describe("humanBytes", () => {
	it("renders base-1000 units and rounds sensibly", () => {
		expect(humanBytes(0)).toBe("0 B");
		expect(humanBytes(512)).toBe("512 B");
		expect(humanBytes(2048)).toBe("2.0 kB");
		expect(humanBytes(3_400_000_000)).toBe("3.4 GB");
		expect(humanBytes(150_000_000)).toBe("150 MB");
	});

	it("treats non-positive / non-finite as 0 B", () => {
		expect(humanBytes(-5)).toBe("0 B");
		expect(humanBytes(Number.NaN)).toBe("0 B");
	});
});

describe("summarizePrune", () => {
	it("sums SpaceReclaimed across all three prunes and counts deletions", () => {
		const r = summarizePrune(
			{ ContainersDeleted: ["a", "b"], SpaceReclaimed: 1000 },
			{ ImagesDeleted: [{}, {}, {}], SpaceReclaimed: 2_000_000_000 },
			{ SpaceReclaimed: 500_000_000 },
		);
		expect(r.ok).toBe(true);
		expect(r.reclaimedBytes).toBe(2_500_001_000);
		expect(r.containersDeleted).toBe(2);
		expect(r.imagesDeleted).toBe(3);
		expect(r.reclaimedHuman).toBe("2.5 GB");
		expect(r.error).toBeNull();
	});

	it("treats missing/null fields as zero (dockerode omits empty results)", () => {
		const r = summarizePrune({}, { ImagesDeleted: null }, {});
		expect(r.reclaimedBytes).toBe(0);
		expect(r.containersDeleted).toBe(0);
		expect(r.imagesDeleted).toBe(0);
		expect(r.reclaimedHuman).toBe("0 B");
	});
});
