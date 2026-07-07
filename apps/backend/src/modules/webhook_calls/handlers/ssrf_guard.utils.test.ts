import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl, SsrfBlockedError } from "./ssrf_guard.utils";

// DNS-dependent branches (hostname resolution) are intentionally not covered
// here: `ssrf_guard.utils` is transitively imported by `test/setup.ts` (via
// `db.ts` -> `users.table.ts` -> `events.utils.ts` ->
// `subscription_alert_webhook.handler.ts`) before this file's own module
// graph loads, so `node:dns/promises` is already bound to the real
// implementation by the time a per-test `vi.mock` would hoist — mocking it
// here has no effect. The literal-IP branches below don't need DNS at all
// and are fully deterministic.
describe("assertSafeWebhookUrl", () => {
	it("rejects an unparsable URL", async () => {
		await expect(assertSafeWebhookUrl("not-a-url")).rejects.toThrow(
			SsrfBlockedError,
		);
	});

	it("rejects a non-https scheme", async () => {
		await expect(
			assertSafeWebhookUrl("http://example.com/hook"),
		).rejects.toThrow("must use https");
	});

	it("rejects a file:// scheme", async () => {
		await expect(assertSafeWebhookUrl("file:///etc/passwd")).rejects.toThrow(
			SsrfBlockedError,
		);
	});

	it("rejects credentials embedded in the URL", async () => {
		await expect(
			assertSafeWebhookUrl("https://user:pass@example.com/hook"),
		).rejects.toThrow("must not contain credentials");
	});

	it("rejects a literal loopback IPv4 address", async () => {
		await expect(
			assertSafeWebhookUrl("https://127.0.0.1/hook"),
		).rejects.toThrow("blocked address");
	});

	it("rejects a literal RFC1918 private IPv4 address", async () => {
		await expect(assertSafeWebhookUrl("https://10.1.2.3/hook")).rejects.toThrow(
			"blocked address",
		);
	});

	it("rejects the cloud metadata IPv4 address", async () => {
		await expect(
			assertSafeWebhookUrl("https://169.254.169.254/hook"),
		).rejects.toThrow("blocked address");
	});

	it("rejects a CGNAT IPv4 address", async () => {
		await expect(
			assertSafeWebhookUrl("https://100.64.1.1/hook"),
		).rejects.toThrow("blocked address");
	});

	it("allows a literal public IPv4 address", async () => {
		const parsed = await assertSafeWebhookUrl("https://8.8.8.8/hook");
		expect(parsed.hostname).toBe("8.8.8.8");
	});
});
