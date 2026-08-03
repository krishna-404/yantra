/**
 * Minimal 5-field cron matching for Routines (#18).
 *
 * Routines are DB rows, not process-level timers: a routine fires, does its
 * work, then computes its own next run and stores it. That means we need
 * "when does this expression next match?" as a pure function — node-cron only
 * schedules in-process callbacks, which is exactly the fragility (dies on
 * restart, not multi-replica safe) that Routines exist to avoid.
 *
 * Supported per field: `*`, `n`, `a-b`, `a,b,c`, `* /n` and `a-b/n`.
 * Field order: minute hour day-of-month month day-of-week (0 = Sunday).
 * All evaluation is UTC.
 */

export interface CronFields {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
}

const RANGES: [number, number][] = [
	[0, 59], // minute
	[0, 23], // hour
	[1, 31], // day of month
	[1, 12], // month
	[0, 6], // day of week
];

/** Expands one field into the explicit list of values it matches. */
const parseField = (raw: string, min: number, max: number): number[] => {
	const out = new Set<number>();
	for (const part of raw.split(",")) {
		const [spec, stepRaw] = part.split("/");
		const step = stepRaw ? Number(stepRaw) : 1;
		if (!Number.isInteger(step) || step < 1)
			throw new Error(`bad step: ${part}`);

		let lo = min;
		let hi = max;
		if (spec && spec !== "*") {
			const [a, b] = spec.split("-");
			lo = Number(a);
			hi = b === undefined ? Number(a) : Number(b);
			if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
				throw new Error(`bad range: ${part}`);
			}
			// A bare `n/step` means "from n to the field max, every step".
			if (b === undefined && stepRaw) hi = max;
		}
		if (lo < min || hi > max || lo > hi)
			throw new Error(`out of range: ${part}`);
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return [...out].sort((x, y) => x - y);
};

export const parseCron = (expr: string): CronFields => {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`cron must have 5 fields, got ${parts.length}`);
	}
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((p, i) => {
		const range = RANGES[i];
		if (!range) throw new Error("unreachable");
		return parseField(p as string, range[0], range[1]);
	});
	return {
		minute: minute as number[],
		hour: hour as number[],
		dayOfMonth: dayOfMonth as number[],
		month: month as number[],
		dayOfWeek: dayOfWeek as number[],
	};
};

/** True when `date` (UTC) satisfies the expression. */
export const matchesCron = (fields: CronFields, date: Date): boolean => {
	// Standard cron quirk: when BOTH day-of-month and day-of-week are
	// restricted, either matching is enough (they're OR'd, not AND'd).
	const domRestricted = fields.dayOfMonth.length !== 31;
	const dowRestricted = fields.dayOfWeek.length !== 7;
	const domHit = fields.dayOfMonth.includes(date.getUTCDate());
	const dowHit = fields.dayOfWeek.includes(date.getUTCDay());
	const dayOk =
		domRestricted && dowRestricted ? domHit || dowHit : domHit && dowHit;

	return (
		fields.minute.includes(date.getUTCMinutes()) &&
		fields.hour.includes(date.getUTCHours()) &&
		fields.month.includes(date.getUTCMonth() + 1) &&
		dayOk
	);
};

/**
 * The next UTC instant strictly after `from` that matches, or null if nothing
 * matches within `horizonDays`.
 *
 * Scans minute by minute. A full year is ~527k cheap integer checks — measured
 * at ~58 ms worst case (no match at all) and ~2 ms for a typical monthly
 * schedule, called a handful of times an hour. The year horizon is what makes
 * monthly and quarterly routines work; an 8-day scan silently never scheduled
 * them. A cron matching less often than annually (e.g. Feb 29) returns null and
 * the caller falls back to a fixed delay, rather than the routine going dark.
 */
export const nextRunAt = (
	expr: string,
	from: Date,
	horizonDays = 366,
): Date | null => {
	const fields = parseCron(expr);
	const cursor = new Date(from.getTime());
	cursor.setUTCSeconds(0, 0);
	cursor.setUTCMinutes(cursor.getUTCMinutes() + 1); // strictly after
	const limit = horizonDays * 24 * 60;
	for (let i = 0; i < limit; i++) {
		if (matchesCron(fields, cursor)) return new Date(cursor.getTime());
		cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
	}
	return null;
};

/** Cheap validity check for the settings UI / API input. */
export const isValidCron = (expr: string): boolean => {
	try {
		parseCron(expr);
		return true;
	} catch {
		return false;
	}
};
