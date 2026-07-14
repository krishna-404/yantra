import { API_PRODUCTS } from "@connected-repo/zod-schemas/enums.zod";
import { describe, expect, it } from "vitest";
import {
	calculateSubscriptionParams,
	getProductConfig,
} from "./calculate_subscription_params.utils";

const KNOWN_SKU = API_PRODUCTS[0].sku;
const KNOWN_PRODUCT = API_PRODUCTS[0];

describe("getProductConfig", () => {
	it("returns the matching product config for a known SKU", () => {
		const config = getProductConfig(KNOWN_SKU);
		expect(config).toBeDefined();
		expect(config?.sku).toBe(KNOWN_SKU);
	});

	it("returns undefined for an unknown SKU", () => {
		const config = getProductConfig("nonexistent_sku" as typeof KNOWN_SKU);
		expect(config).toBeUndefined();
	});
});

describe("calculateSubscriptionParams", () => {
	it("returns correct params for a known SKU with positive quantity", () => {
		const quantity = 3;
		const result = calculateSubscriptionParams(KNOWN_SKU, quantity);

		expect(result).toEqual({
			maxRequests: KNOWN_PRODUCT.unitSize * quantity,
			validityDays: KNOWN_PRODUCT.validityDays,
		});
	});

	it("returns maxRequests of 0 when quantity is 0", () => {
		const result = calculateSubscriptionParams(KNOWN_SKU, 0);

		expect(result).toEqual({
			maxRequests: KNOWN_PRODUCT.unitSize * 0,
			validityDays: KNOWN_PRODUCT.validityDays,
		});
	});

	it("throws for an unknown SKU", () => {
		expect(() =>
			calculateSubscriptionParams("nonexistent_sku" as typeof KNOWN_SKU, 1),
		).toThrow("Unknown product SKU");
	});
});
