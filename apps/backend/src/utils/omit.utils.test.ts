import { describe, expect, it } from "vitest";
import { omitKeys } from "./omit.utils";

describe("omitKeys", () => {
	it("removes the listed keys", () => {
		const input = { a: 1, b: 2, c: 3 };
		const result = omitKeys(input, ["a", "c"]);
		expect(result).toEqual({ b: 2 });
	});

	it("leaves the other keys intact", () => {
		const input = { a: 1, b: 2, c: 3 };
		const result = omitKeys(input, ["b"]);
		expect(result).toMatchObject({ a: 1, c: 3 });
	});

	it("returns a new object and does not mutate the input", () => {
		const input = { a: 1, b: 2, c: 3 };
		const result = omitKeys(input, ["a"]);
		expect(result).not.toBe(input);
		expect(input).toEqual({ a: 1, b: 2, c: 3 });
	});

	it("returns an equivalent copy when keys is empty", () => {
		const input = { a: 1, b: 2, c: 3 };
		const result = omitKeys(input, []);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
	});

	it("handles keys that are not present on the object", () => {
		const input = { a: 1, b: 2 };
		const result = omitKeys(input, ["c" as keyof typeof input]);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
	});
});
