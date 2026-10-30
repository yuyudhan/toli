import { ToliError } from "./util.ts";

/** A parsed 5-field cron expression: minute hour day-of-month month day-of-week. */
export type Cron = {
    minutes: Set<number>;
    hours: Set<number>;
    daysOfMonth: Set<number>;
    months: Set<number>;
    /** 0-6, Sunday = 0 (a 7 in the expression is folded to 0). */
    daysOfWeek: Set<number>;
    /** True when the day-of-month field was `*` (or `*` with a step). */
    domStar: boolean;
    /** True when the day-of-week field was `*` (or `*` with a step). */
    dowStar: boolean;
};

type FieldSpec = { label: string; min: number; max: number };

const FIELDS: readonly FieldSpec[] = [
    { label: "minute", min: 0, max: 59 },
    { label: "hour", min: 0, max: 23 },
    { label: "day-of-month", min: 1, max: 31 },
    { label: "month", min: 1, max: 12 },
    { label: "day-of-week", min: 0, max: 7 },
];

function parseNumber(text: string, spec: FieldSpec, expr: string): number {
    if (!/^\d+$/.test(text)) throw new ToliError(`cron "${expr}": bad ${spec.label} value "${text}"`);
    const value = Number(text);
    if (value < spec.min || value > spec.max) {
        throw new ToliError(`cron "${expr}": ${spec.label} ${value} outside ${spec.min}-${spec.max}`);
    }
    return value;
}

type ParsedField = { values: Set<number>; star: boolean };

function parseField(field: string, spec: FieldSpec, expr: string): ParsedField {
    const values = new Set<number>();
    let star = false;
    for (const part of field.split(",")) {
        if (part === "") throw new ToliError(`cron "${expr}": empty item in ${spec.label} field`);
        const [rangeText, stepText, extra] = part.split("/");
        if (extra !== undefined || rangeText === undefined) {
            throw new ToliError(`cron "${expr}": bad ${spec.label} item "${part}"`);
        }
        let step = 1;
        if (stepText !== undefined) {
            step = parseNumber(stepText, { ...spec, min: 1, max: spec.max + 1 }, expr);
        }
        let low: number;
        let high: number;
        if (rangeText === "*") {
            star = star || field.split(",").length === 1;
            low = spec.min;
            high = spec.max;
        } else if (rangeText.includes("-")) {
            const [lowText, highText, more] = rangeText.split("-");
            if (lowText === undefined || highText === undefined || more !== undefined) {
                throw new ToliError(`cron "${expr}": bad ${spec.label} range "${rangeText}"`);
            }
            low = parseNumber(lowText, spec, expr);
            high = parseNumber(highText, spec, expr);
            if (low > high) throw new ToliError(`cron "${expr}": ${spec.label} range ${rangeText} is reversed`);
        } else {
            low = parseNumber(rangeText, spec, expr);
            high = stepText === undefined ? low : spec.max;
        }
        for (let value = low; value <= high; value += step) values.add(value);
    }
    return { values, star };
}

export function parseCron(expr: string): Cron {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) throw new ToliError(`cron "${expr}": expected 5 fields (m h dom mon dow)`);
    const parsed = fields.map((field, index) => parseField(field, FIELDS[index] as FieldSpec, expr));
    const [minute, hour, dom, month, dow] = parsed as [ParsedField, ParsedField, ParsedField, ParsedField, ParsedField];
    return {
        minutes: minute.values,
        hours: hour.values,
        daysOfMonth: dom.values,
        months: month.values,
        daysOfWeek: new Set([...dow.values].map((day) => day % 7)),
        domStar: dom.star,
        dowStar: dow.star,
    };
}

/**
 * Whether `date` (local time, seconds ignored) matches. Standard cron day rule: when both
 * day-of-month and day-of-week are restricted, a day matching either one fires.
 */
export function cronMatches(cron: Cron, date: Date): boolean {
    if (!cron.minutes.has(date.getMinutes())) return false;
    if (!cron.hours.has(date.getHours())) return false;
    if (!cron.months.has(date.getMonth() + 1)) return false;
    const domOk = cron.daysOfMonth.has(date.getDate());
    const dowOk = cron.daysOfWeek.has(date.getDay());
    if (cron.domStar && cron.dowStar) return true;
    if (cron.domStar) return dowOk;
    if (cron.dowStar) return domOk;
    return domOk || dowOk;
}

const MINUTE_MS = 60_000;
/** Catch-up look-back cap: a job missed for longer than this still fires once, judged on this window. */
const MAX_LOOKBACK_MINUTES = 366 * 24 * 60;

/**
 * Whether any whole minute in (after, until] matches; scans backwards from `until`, so frequent
 * schedules return immediately. Used for catch-up: many missed minutes still mean a single run.
 */
export function cronFiredBetween(cron: Cron, after: Date, until: Date): boolean {
    const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS;
    let cursor = Math.floor(until.getTime() / MINUTE_MS) * MINUTE_MS;
    const floor = Math.max(start, cursor - MAX_LOOKBACK_MINUTES * MINUTE_MS);
    for (; cursor > floor; cursor -= MINUTE_MS) {
        if (cronMatches(cron, new Date(cursor))) return true;
    }
    return false;
}
