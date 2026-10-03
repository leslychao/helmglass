import { BrowserSession } from '../api/models';

/** Server-confirmed activity, shared by snapshots, input receipts and event channels. */
export interface BrowserClock {
  browserSessionId: string;
  allocationEpoch: number;
  privacyEpoch: number;
  lastActivityAt: string;
  idleDeadlineAt: string;
  budgetDeadlineAt: string;
}

export function browserClockOf(value: unknown): BrowserClock | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (
    !('browserSessionId' in value) ||
    typeof value.browserSessionId !== 'string' ||
    value.browserSessionId.length > 64 ||
    !value.browserSessionId ||
    !('allocationEpoch' in value) ||
    !epoch(value.allocationEpoch) ||
    !('privacyEpoch' in value) ||
    !epoch(value.privacyEpoch) ||
    !('lastActivityAt' in value) ||
    !timestamp(value.lastActivityAt) ||
    !('idleDeadlineAt' in value) ||
    !timestamp(value.idleDeadlineAt) ||
    !('budgetDeadlineAt' in value) ||
    !timestamp(value.budgetDeadlineAt)
  )
    return null;
  return {
    browserSessionId: value.browserSessionId,
    allocationEpoch: value.allocationEpoch,
    privacyEpoch: value.privacyEpoch,
    lastActivityAt: value.lastActivityAt,
    idleDeadlineAt: value.idleDeadlineAt,
    budgetDeadlineAt: value.budgetDeadlineAt,
  };
}

export function sessionClock(session: BrowserSession | null): BrowserClock | null {
  return session?.state === 'ACTIVE'
    ? browserClockOf({ ...session, browserSessionId: session.id })
    : null;
}

export function newerClock(current: BrowserClock | null, next: BrowserClock): BrowserClock {
  if (!current || current.browserSessionId !== next.browserSessionId) return next;
  if (next.allocationEpoch !== current.allocationEpoch)
    return next.allocationEpoch > current.allocationEpoch ? next : current;
  if (next.privacyEpoch !== current.privacyEpoch)
    return next.privacyEpoch > current.privacyEpoch ? next : current;
  const difference = compareTime(next.lastActivityAt, current.lastActivityAt);
  if (difference < 0) return current;
  if (difference === 0 && compareTime(next.idleDeadlineAt, current.idleDeadlineAt) < 0)
    return current;
  if (
    difference === 0 &&
    next.idleDeadlineAt === current.idleDeadlineAt &&
    next.budgetDeadlineAt === current.budgetDeadlineAt
  )
    return current;
  return next;
}

function compareTime(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const fraction = (value: string) => /\.(\d+)Z$/.exec(value)?.[1].padEnd(9, '0') ?? '000000000';
  return fraction(left).localeCompare(fraction(right));
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
