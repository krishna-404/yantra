import { describe, expect, it } from "vitest";
import { getClientIpAddress } from "./client-info.utils";

describe("getClientIpAddress", () => {
	it("returns the single IP from x-forwarded-for", () => {
		const headers = new Headers({ "x-forwarded-for": "9.9.9.9" });
		expect(getClientIpAddress(headers)).toBe("9.9.9.9");
	});

	it("returns the first IP when x-forwarded-for contains multiple IPs", () => {
		const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
		expect(getClientIpAddress(headers)).toBe("1.2.3.4");
	});

	it("falls back to x-real-ip when x-forwarded-for is absent", () => {
		const headers = new Headers({ "x-real-ip": "8.8.8.8" });
		expect(getClientIpAddress(headers)).toBe("8.8.8.8");
	});

	it("returns 'unknown' when neither header is present", () => {
		const headers = new Headers();
		expect(getClientIpAddress(headers)).toBe("unknown");
	});
});
