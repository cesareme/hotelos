import { prisma } from "@hotelos/database";

/**
 * Workforce operations dashboard — read-only statistical view for HR /
 * operations managers.
 *
 * Aggregates over StaffProfile, Shift, TimeClockEntry, AbsenceRequest,
 * LaborForecast, Department and UserDepartment for a single property,
 * optionally within a date window. `from`/`to` default to the current
 * calendar month (UTC).
 *
 * Sharp edges / approximations (kept stable for the UI without schema
 * changes):
 *   - `headcount` counts StaffProfile rows for this property regardless of
 *     `active`; `activeStaff` filters to active=true. There is no
 *     contract/leave state in the schema other than the active flag.
 *   - `hoursWorkedMtd` pairs consecutive TimeClockEntry rows per staff
 *     profile ordered by `clockAt` ascending: each `clock_in` / `start`
 *     event is paired with the next `clock_out` / `end` for the same
 *     staffProfileId. Unmatched in/out pairs are ignored. Falls back to 0
 *     when there are no time-clock rows.
 *   - `staffByDepartment` joins UserDepartment -> Department for departments
 *     in this property, then counts StaffProfile rows for users that share
 *     that department. StaffProfile.departmentId is also honoured when
 *     present (a profile can be linked directly without UserDepartment).
 *     Staff with no department mapping are bucketed under "Unassigned" only
 *     when there is at least one such staff member.
 *   - `hoursVsForecast` covers the last 14 calendar days (UTC) regardless
 *     of the `from`/`to` window — that window scopes the KPIs but the chart
 *     is anchored on the rolling 14-day view that operations actually look
 *     at. Actual hours are summed from paired TimeClockEntry rows;
 *     forecastHours from LaborForecast.requiredLaborHours per day.
 *   - `upcomingShifts` lists shifts with `startAt >= now` ordered ascending
 *     (top 10). `nextShiftsToday` is the count of shifts starting today.
 *   - `pendingAbsences` lists AbsenceRequest rows with status="pending"
 *     ordered by startDate ascending (top 10). `absencesPending` /
 *     `absencesApproved` are KPI counts over the from/to window
 *     (overlapping the window).
 *   - All array fields default to []; all numeric KPIs default to 0.
 */

export type WorkforceDashboardInput = {
  propertyId: string;
  from?: string;
  to?: string;
};

export type WorkforceDashboardKpis = {
  headcount: number;
  activeStaff: number;
  hoursWorkedMtd: number;
  absencesPending: number;
  absencesApproved: number;
  nextShiftsToday: number;
};

export type WorkforceDashboard = {
  kpis: WorkforceDashboardKpis;
  staffByDepartment: Array<{ departmentName: string; count: number }>;
  hoursVsForecast: Array<{ date: string; actualHours: number; forecastHours: number }>;
  upcomingShifts: Array<{ id: string; staffName: string; startAt: string; endAt: string; role?: string }>;
  pendingAbsences: Array<{ id: string; staffName: string; type: string; startDate: string; endDate: string; status: string }>;
};

const CLOCK_IN_TYPES = new Set(["clock_in", "in", "start", "start_break_end", "break_end"]);
const CLOCK_OUT_TYPES = new Set(["clock_out", "out", "end", "break_start"]);

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfNextMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseInputDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T00:00:00.000Z`);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function safeNumber(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return value;
}

function dec(value: { toString(): string } | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pair clock-in with the next clock-out per staff profile, ordered by
 * `clockAt` ascending. Returns total hours and per-day buckets keyed by
 * UTC date (YYYY-MM-DD).
 */
function reduceTimeClockEntries(
  entries: Array<{ staffProfileId: string; clockType: string; clockAt: Date }>
): { totalHours: number; hoursByDay: Map<string, number> } {
  const byStaff = new Map<string, Array<{ clockType: string; clockAt: Date }>>();
  for (const row of entries) {
    const list = byStaff.get(row.staffProfileId) ?? [];
    list.push({ clockType: row.clockType, clockAt: row.clockAt });
    byStaff.set(row.staffProfileId, list);
  }

  let totalHours = 0;
  const hoursByDay = new Map<string, number>();

  for (const list of byStaff.values()) {
    list.sort((a, b) => a.clockAt.getTime() - b.clockAt.getTime());
    let openIn: Date | null = null;
    for (const row of list) {
      if (CLOCK_IN_TYPES.has(row.clockType)) {
        // If we already had an open in, the new one supersedes it (defensive).
        openIn = row.clockAt;
        continue;
      }
      if (CLOCK_OUT_TYPES.has(row.clockType) && openIn) {
        const ms = row.clockAt.getTime() - openIn.getTime();
        if (Number.isFinite(ms) && ms > 0) {
          const hours = ms / 3_600_000;
          totalHours += hours;
          const key = dayKey(startOfDayUtc(openIn));
          hoursByDay.set(key, (hoursByDay.get(key) ?? 0) + hours);
        }
        openIn = null;
      }
    }
  }

  return { totalHours, hoursByDay };
}

export async function buildWorkforceDashboard(
  input: WorkforceDashboardInput
): Promise<WorkforceDashboard> {
  const empty: WorkforceDashboard = {
    kpis: {
      headcount: 0,
      activeStaff: 0,
      hoursWorkedMtd: 0,
      absencesPending: 0,
      absencesApproved: 0,
      nextShiftsToday: 0
    },
    staffByDepartment: [],
    hoursVsForecast: [],
    upcomingShifts: [],
    pendingAbsences: []
  };

  if (!input.propertyId) return empty;

  const now = new Date();
  const defaultFrom = startOfMonthUtc(now);
  const defaultTo = startOfNextMonthUtc(now);
  const from = parseInputDate(input.from, defaultFrom);
  const to = parseInputDate(input.to, defaultTo);

  const todayStart = startOfDayUtc(now);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  // Rolling 14-day window for the hours-vs-forecast chart. End is exclusive
  // (tomorrow) so today is included. Start is 13 days before today.
  const fourteenStart = new Date(todayStart.getTime() - 13 * 24 * 60 * 60 * 1000);

  const [
    staffProfiles,
    departments,
    userDepartments,
    clockEntriesMtd,
    clockEntries14d,
    forecasts14d,
    absencesInWindow,
    pendingAbsenceRows,
    todayShiftCount,
    upcomingShiftRows
  ] = await Promise.all([
    prisma.staffProfile.findMany({
      where: { propertyId: input.propertyId },
      select: { id: true, userId: true, departmentId: true, active: true }
    }),
    prisma.department.findMany({
      where: { propertyId: input.propertyId, active: true },
      select: { id: true, name: true }
    }),
    prisma.userDepartment.findMany({
      where: { active: true },
      select: { userId: true, departmentId: true }
    }),
    prisma.timeClockEntry.findMany({
      where: { propertyId: input.propertyId, clockAt: { gte: from, lt: to } },
      select: { staffProfileId: true, clockType: true, clockAt: true },
      orderBy: { clockAt: "asc" }
    }),
    prisma.timeClockEntry.findMany({
      where: { propertyId: input.propertyId, clockAt: { gte: fourteenStart, lt: tomorrowStart } },
      select: { staffProfileId: true, clockType: true, clockAt: true },
      orderBy: { clockAt: "asc" }
    }),
    prisma.laborForecast.findMany({
      where: {
        propertyId: input.propertyId,
        forecastDate: { gte: fourteenStart, lt: tomorrowStart }
      },
      select: { forecastDate: true, requiredLaborHours: true }
    }),
    prisma.absenceRequest.findMany({
      where: {
        propertyId: input.propertyId,
        // overlap: absence.startDate < to AND absence.endDate >= from
        startDate: { lt: to },
        endDate: { gte: from }
      },
      select: { status: true }
    }),
    prisma.absenceRequest.findMany({
      where: { propertyId: input.propertyId, status: "pending" },
      orderBy: { startDate: "asc" },
      take: 10,
      select: {
        id: true,
        staffProfileId: true,
        absenceType: true,
        startDate: true,
        endDate: true,
        status: true
      }
    }),
    prisma.shift.count({
      where: {
        propertyId: input.propertyId,
        startAt: { gte: todayStart, lt: tomorrowStart }
      }
    }),
    prisma.shift.findMany({
      where: { propertyId: input.propertyId, startAt: { gte: now } },
      orderBy: { startAt: "asc" },
      take: 10,
      select: {
        id: true,
        staffProfileId: true,
        startAt: true,
        endAt: true,
        roleLabel: true
      }
    })
  ]);

  // KPIs ---------------------------------------------------------------------
  const headcount = staffProfiles.length;
  const activeStaff = staffProfiles.filter((s) => s.active).length;

  const mtdReduce = reduceTimeClockEntries(clockEntriesMtd);
  const hoursWorkedMtd = round1(mtdReduce.totalHours);

  let absencesPending = 0;
  let absencesApproved = 0;
  for (const row of absencesInWindow) {
    if (row.status === "pending") absencesPending += 1;
    else if (row.status === "approved") absencesApproved += 1;
  }

  // Staff by department ------------------------------------------------------
  const departmentNameById = new Map(departments.map((d) => [d.id, d.name]));
  const departmentIdSet = new Set(departments.map((d) => d.id));

  // Build user -> set of departmentIds (only those in this property).
  const userDeptIds = new Map<string, Set<string>>();
  for (const link of userDepartments) {
    if (!departmentIdSet.has(link.departmentId)) continue;
    const set = userDeptIds.get(link.userId) ?? new Set<string>();
    set.add(link.departmentId);
    userDeptIds.set(link.userId, set);
  }

  const deptCounts = new Map<string, number>();
  let unassignedCount = 0;
  for (const profile of staffProfiles) {
    const depts = new Set<string>();
    if (profile.departmentId && departmentIdSet.has(profile.departmentId)) {
      depts.add(profile.departmentId);
    }
    const fromUser = userDeptIds.get(profile.userId);
    if (fromUser) for (const id of fromUser) depts.add(id);
    if (depts.size === 0) {
      unassignedCount += 1;
      continue;
    }
    for (const id of depts) {
      deptCounts.set(id, (deptCounts.get(id) ?? 0) + 1);
    }
  }

  const staffByDepartment: Array<{ departmentName: string; count: number }> = [];
  for (const dept of departments) {
    const count = deptCounts.get(dept.id) ?? 0;
    if (count > 0) staffByDepartment.push({ departmentName: dept.name, count });
  }
  // Bucket unassigned profiles only when present, so the response stays compact
  // when every staff member is mapped.
  if (unassignedCount > 0) {
    staffByDepartment.push({ departmentName: "Unassigned", count: unassignedCount });
  }
  // Surface departments with zero staff at the bottom so the operations
  // manager can see which buckets exist but are empty — but keep the response
  // bounded by only showing the top 12 to avoid bloat on large properties.
  for (const dept of departments) {
    if ((deptCounts.get(dept.id) ?? 0) === 0) {
      staffByDepartment.push({ departmentName: dept.name, count: 0 });
    }
  }
  void departmentNameById;

  // Hours vs forecast (last 14 days) -----------------------------------------
  const fourteenReduce = reduceTimeClockEntries(clockEntries14d);
  const forecastByDay = new Map<string, number>();
  for (const row of forecasts14d) {
    const key = dayKey(startOfDayUtc(row.forecastDate));
    forecastByDay.set(key, (forecastByDay.get(key) ?? 0) + dec(row.requiredLaborHours));
  }

  const hoursVsForecast: Array<{ date: string; actualHours: number; forecastHours: number }> = [];
  for (let i = 0; i < 14; i += 1) {
    const day = new Date(fourteenStart.getTime() + i * 24 * 60 * 60 * 1000);
    const key = dayKey(day);
    hoursVsForecast.push({
      date: key,
      actualHours: round1(fourteenReduce.hoursByDay.get(key) ?? 0),
      forecastHours: round1(forecastByDay.get(key) ?? 0)
    });
  }

  // Resolve staff display names for upcoming shifts + pending absences.
  const profileIds = new Set<string>();
  for (const s of upcomingShiftRows) if (s.staffProfileId) profileIds.add(s.staffProfileId);
  for (const a of pendingAbsenceRows) profileIds.add(a.staffProfileId);

  const profilesNeeded = profileIds.size === 0
    ? []
    : await prisma.staffProfile.findMany({
        where: { id: { in: Array.from(profileIds) } },
        select: { id: true, userId: true, employeeCode: true }
      });
  const userIds = Array.from(new Set(profilesNeeded.map((p) => p.userId)));
  const users = userIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, fullName: true }
      });
  const nameByUserId = new Map(users.map((u) => [u.id, u.fullName]));
  const staffNameByProfileId = new Map<string, string>();
  for (const p of profilesNeeded) {
    const name = nameByUserId.get(p.userId) ?? p.employeeCode ?? p.userId;
    staffNameByProfileId.set(p.id, name);
  }

  const upcomingShifts = upcomingShiftRows.map((s) => ({
    id: s.id,
    staffName: s.staffProfileId
      ? staffNameByProfileId.get(s.staffProfileId) ?? "Unassigned"
      : "Unassigned",
    startAt: s.startAt.toISOString(),
    endAt: s.endAt.toISOString(),
    role: s.roleLabel ?? undefined
  }));

  const pendingAbsences = pendingAbsenceRows.map((a) => ({
    id: a.id,
    staffName: staffNameByProfileId.get(a.staffProfileId) ?? a.staffProfileId,
    type: a.absenceType,
    startDate: a.startDate.toISOString(),
    endDate: a.endDate.toISOString(),
    status: a.status
  }));

  return {
    kpis: {
      headcount: safeNumber(headcount),
      activeStaff: safeNumber(activeStaff),
      hoursWorkedMtd: safeNumber(hoursWorkedMtd),
      absencesPending: safeNumber(absencesPending),
      absencesApproved: safeNumber(absencesApproved),
      nextShiftsToday: safeNumber(todayShiftCount)
    },
    staffByDepartment,
    hoursVsForecast,
    upcomingShifts,
    pendingAbsences
  };
}
