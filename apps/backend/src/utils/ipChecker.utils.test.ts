import { describe, expect, it } from "vitest";
import { isIPWhitelisted } from "./ipChecker.utils";

describe("isIPWhitelisted", () => {
	it("returns true for exact IPv4 match", () => {
		expect(isIPWhitelisted("192.168.1.10", "192.168.1.10")).toBe(true);
	});

	it("returns false for different IPv4 addresses", () => {
		expect(isIPWhitelisted("192.168.1.10", "192.168.1.11")).toBe(false);
	});

	it("returns true for IPv6 addresses with different formatting", () => {
		expect(isIPWhitelisted("::1", "0:0:0:0:0:0:0:1")).toBe(true);
		expect(isIPWhitelisted("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
	});

	it("returns false for different IPv6 addresses", () => {
		expect(isIPWhitelisted("::1", "::2")).toBe(false);
	});

	it("returns false for mixed IPv4 and IPv6 families", () => {
		expect(isIPWhitelisted("192.168.1.10", "::1")).toBe(false);
	});
});