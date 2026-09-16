import { isProxy } from "node:util/types";

/**
 * D-012 §9 schedule gates for copy/export handoff attempts: recipient-local
 * quiet hours and a per-contact daily frequency cap. Unknown or malformed
 * timezones fail closed — a recipient-local hour can never be guessed.
 */

export const D012_QUIET_HOURS = Object.freeze({ startHour: 21, endHour: 8 } as const);
export const D012_MAX_HANDOFFS_PER_CONTACT_PER_DAY = 3 as const;
export const D012_ALLOWED_HANDOFF_HOURS_PER_DAY = 10 as const;

export type HandoffScheduleCode =
  | "SCHEDULE_ALLOWED"
  | "SCHEDULE_BLOCKED_QUIET_HOURS"
  | "SCHEDULE_BLOCKED_FREQUENCY_CAP"
  | "SCHEDULE_BLOCKED_DAY_EXHAUSTED"
  | "SCHEDULE_INVALID";

export type HandoffScheduleResult = Readonly<{
  ok: boolean;
  code: HandoffScheduleCode;
  recipientLocalHour: number | null;
}>;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function recipientLocalParts(
  at: string,
  timeZone: string,
): { hour: number; minute: number; dayKey: string } | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(at));
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hourRaw = get("hour");
    const minute = get("minute");
    if (!year || !month || !day || !hourRaw || !minute) return null;
    const hour = Number(hourRaw === "24" ? "0" : hourRaw);
    if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23 || !/^\d{2}$/u.test(minute)) return null;
    return Object.freeze({ hour, minute: Number(minute), dayKey: `${year}-${month}-${day}` });
  } catch {
    return null;
  }
}

function minutesOf(parts: { hour: number; minute: number }): number {
  return parts.hour * 60 + parts.minute;
}

/**
 * The recipient-local calendar day ("YYYY-MM-DD") a handoff instant falls on,
 * or null when the instant or timezone cannot be resolved. Frequency-cap
 * accounting keys attempt records by this value.
 */
export function recipientLocalDayKey(at: string, timeZone: string): string | null {
  if (!ISO.test(at) || typeof timeZone !== "string" || timeZone.length === 0) return null;
  return recipientLocalParts(at, timeZone)?.dayKey ?? null;
}

/**
 * Evaluates one planned handoff against quiet hours and the count of prior
 * allowed attempts already released for the same contact-local day.
 * `priorAttemptsToday` must come from the server's own attempt records.
 */
export function evaluateHandoffSchedule(input: unknown): HandoffScheduleResult {
  try {
    if (isProxy(input) || typeof input !== "object" || input === null || Array.isArray(input)) {
      return Object.freeze({ ok: false, code: "SCHEDULE_INVALID", recipientLocalHour: null });
    }
    const record = input as Record<string, unknown>;
    const plannedAt = typeof record.plannedAt === "string" && ISO.test(record.plannedAt)
      ? record.plannedAt : null;
    const timeZone = typeof record.timeZone === "string" ? record.timeZone : null;
    const priorAttemptsToday = Number.isSafeInteger(record.priorAttemptsToday)
      && (record.priorAttemptsToday as number) >= 0
      ? record.priorAttemptsToday as number : null;
    const quiet = isProxy(record.quietHours) || typeof record.quietHours !== "object"
      || record.quietHours === null
      ? null
      : record.quietHours as Record<string, unknown>;
    const startHour = quiet && Number.isSafeInteger(quiet.startHour)
      && (quiet.startHour as number) >= 0 && (quiet.startHour as number) <= 23
      ? quiet.startHour as number : null;
    const endHour = quiet && Number.isSafeInteger(quiet.endHour)
      && (quiet.endHour as number) >= 0 && (quiet.endHour as number) <= 23
      ? quiet.endHour as number : null;
    const maxPerDay = Number.isSafeInteger(record.maxPerDay) && (record.maxPerDay as number) >= 1
      ? record.maxPerDay as number : null;
    const allowedHoursPerDay = Number.isSafeInteger(record.allowedHoursPerDay)
      && (record.allowedHoursPerDay as number) >= 1 && (record.allowedHoursPerDay as number) <= 24
      ? record.allowedHoursPerDay as number : null;
    if (!plannedAt || !timeZone || priorAttemptsToday === null || !quiet || startHour === null
      || endHour === null || maxPerDay === null || allowedHoursPerDay === null) {
      return Object.freeze({ ok: false, code: "SCHEDULE_INVALID", recipientLocalHour: null });
    }
    const parts = recipientLocalParts(plannedAt, timeZone);
    if (!parts) {
      return Object.freeze({ ok: false, code: "SCHEDULE_INVALID", recipientLocalHour: null });
    }
    const quietStart = startHour * 60;
    const quietEnd = endHour * 60;
    const atMinute = minutesOf(parts);
    const inQuiet = quietStart < quietEnd
      ? atMinute >= quietStart && atMinute < quietEnd
      : quietStart > quietEnd
        ? atMinute >= quietStart || atMinute < quietEnd
        : false;
    if (inQuiet) {
      return Object.freeze({
        ok: false, code: "SCHEDULE_BLOCKED_QUIET_HOURS", recipientLocalHour: parts.hour });
    }
    if (quietStart === quietEnd && allowedHoursPerDay < 24) {
      return Object.freeze({ ok: false, code: "SCHEDULE_INVALID", recipientLocalHour: parts.hour });
    }
    if (priorAttemptsToday >= maxPerDay) {
      return Object.freeze({
        ok: false, code: "SCHEDULE_BLOCKED_FREQUENCY_CAP", recipientLocalHour: parts.hour });
    }
    return Object.freeze({ ok: true, code: "SCHEDULE_ALLOWED", recipientLocalHour: parts.hour });
  } catch {
    return Object.freeze({ ok: false, code: "SCHEDULE_INVALID", recipientLocalHour: null });
  }
}
