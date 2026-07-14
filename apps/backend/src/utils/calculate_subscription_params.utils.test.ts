import type { ApiProductSku } from "@connected-repo/zod-schemas/enums.zod";
import { API_PRODUCTS } from "@connected-repo/zod-schemas/enums.zod";
import { describe, expect, it } from "vitest";
import {
	calculateSubscriptionParams,
	getProductConfig,
} from "./calculate_subscription_params.utils";

const realProduct = API_PRODUCTS[0];
const realSku = realProduct.sku;

describe("getProductConfig", () => {
	it("returns the matching product config for a known SKU", () => {
		const result = getProductConfig(realSku);
		expect(result).toEqual(realProduct);
	});

	it("returns undefined for an unknown SKU", () => {
		const result = getProductConfig("non_existent_sku" as ApiProductSku);
		expect(result).toBeUndefined();
	});
});

describe("calculateSubscriptionParams", () => {
	it("returns correct params for a known SKU with positive quantity", () => {
		const quantity = 5;
		const result = calculateSubscriptionParams(realSku, quantity);
		expect(result).toEqual({
			maxRequests: realProduct.unitSize * quantity,
			validityDays: realProduct.validityDays,
		});
	});

	it("handles quantity of 0 correctly", () => {
		const result = calculateSubscriptionParams(realSku, 0);
		expect(result).toEqual({
			maxRequests: 0,
			validityDays: realProduct.validityDays,
		});
	});

	it("throws 'Unknown product SKU' for an unknown SKU", () => {
		expect(() =>
			calculateSubscriptionParams("unknown_sku" as ApiProductSku, 1),
		).toThrow("Unknown product SKU");
	});
});
