import { describe, expect, it } from "vitest";
import { getClientIpAddress } from "./client-info.utils";

describe("getClientIpAddress", () => {
	it("with x-forwarded-for set to a single IP, returns that IP", () => {
		const headers = new Headers({ "x-forwarded-for": "9.9.9.9" });
		expect(getClientIpAddress(headers)).toBe("9.9.9.9");
	});

	it("with x-forwarded-for containing multiple comma-separated IPs, returns the FIRST one, trimmed", () => {
		const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
		expect(getClientIpAddress(headers)).toBe("1.2.3.4");
	});

	it("with no x-forwarded-for but x-real-ip set, returns the x-real-ip value", () => {
		const headers = new Headers({ "x-real-ip": "8.8.8.8" });
		expect(getClientIpAddress(headers)).toBe("8.8.8.8");
	});

	it("with neither header present, returns 'unknown'", () => {
		const headers = new Headers({});
		expect(getClientIpAddress(headers)).toBe("unknown");
	});
});
