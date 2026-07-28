import { buildSucceeded } from "@backend/modules/yantra/services/exec_image_builder.yantra.service";
import { describe, expect, it } from "vitest";

describe("buildSucceeded", () => {
	it("is true when the stream names/tags an image and has no trailing error", () => {
		expect(
			buildSucceeded(
				"Step 7/7 ...\nnaming to docker.io/library/yantra-exec-oc:0",
			),
		).toBe(true);
		expect(buildSucceeded("... writing image sha256:abc done")).toBe(true);
	});

	it("is false when the build errors", () => {
		expect(
			buildSucceeded("Step 3/7\nERROR: npm install failed with code 1"),
		).toBe(false);
	});

	it("is false when the stream never produced a tagged image", () => {
		expect(buildSucceeded("pulling base image...\nresolving layers")).toBe(
			false,
		);
	});
});
