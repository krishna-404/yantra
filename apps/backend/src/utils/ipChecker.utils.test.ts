import { describe, expect, it } from "vitest";
import { isIPWhitelisted } from "./ipChecker.utils";

describe("isIPWhitelisted", () => {
	it("returns true for an exact IPv4 match", () => {
		expect(isIPWhitelisted("192.168.1.10", "192.168.1.10")).toBe(true);
	});

	it("returns false for a different IPv4 address", () => {
		expect(isIPWhitelisted("192.168.1.10", "192.168.1.11")).toBe(false);
	});

	it("returns true for a compressed IPv6 address matching its fully-expanded form", () => {
		expect(isIPWhitelisted("::1", "0:0:0:0:0:0:0:1")).toBe(true);
	});

	it("returns true for a partially-compressed IPv6 address matching its fully-expanded form", () => {
		expect(
			isIPWhitelisted("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"),
		).toBe(true);
	});

	it("returns false for two different IPv6 addresses", () => {
		expect(isIPWhitelisted("2001:db8::1", "2001:db8::2")).toBe(false);
	});

	it("returns false when comparing an IPv4 address to an IPv6 address", () => {
		expect(isIPWhitelisted("192.168.1.10", "::1")).toBe(false);
	});
});
