import { describe, expect, it } from "vitest";
import { isIPWhitelisted } from "./ipChecker.utils";

describe("isIPWhitelisted", () => {
	it("IPv4 exact match returns true", () => {
		expect(isIPWhitelisted("192.168.1.10", "192.168.1.10")).toBe(true);
	});

	it("IPv4 mismatch returns false", () => {
		expect(isIPWhitelisted("192.168.1.10", "192.168.1.11")).toBe(false);
	});

	it("IPv6 compressed ::1 matches fully expanded form", () => {
		expect(isIPWhitelisted("::1", "0:0:0:0:0:0:0:1")).toBe(true);
	});

	it("IPv6 2001:db8::1 matches fully expanded form with zero-padded hextets", () => {
		expect(
			isIPWhitelisted("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"),
		).toBe(true);
	});

	it("two different IPv6 addresses return false", () => {
		expect(isIPWhitelisted("::1", "::2")).toBe(false);
	});

	it("IPv4 and IPv6 (mixed family) return false", () => {
		expect(isIPWhitelisted("192.168.1.10", "::1")).toBe(false);
	});
});
