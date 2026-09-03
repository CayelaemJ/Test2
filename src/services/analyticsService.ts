// ════════════════════════════════════════════════════════════════════
//  ENGAGEMENT ANALYTICS
//  Minimal client-reach tracking for admins: how many people sign in, how
//  many pages they view, and how far they scroll. Logins/active-user counts
//  are derived from the existing Session table (no need to duplicate them);
//  AnalyticsEvent only stores pageviews and scroll-depth beacons.
// ════════════════════════════════════════════════════════════════════

import { prisma } from "./authService.js";

type EventType = "PAGEVIEW" | "SCROLL_DEPTH" | "SESSION_END";

export async function recordEvent(opts: {
  userId: string | null;
  type: EventType;
  path: string;
  value?: number | null;
  partnerId?: string | null;
}) {
  if (!opts.path || opts.path.length > 300) return { ok: false };
  await prisma.analyticsEvent.create({
    data: {
      userId: opts.userId,
      type: opts.type as any,
      path: opts.path.slice(0, 300),
      value: typeof opts.value === "number" && Number.isFinite(opts.value) ? Math.max(0, Math.min(100000, Math.round(opts.value))) : null,
      partnerId: opts.partnerId || null,
    },
  });
  return { ok: true };
}

// admin-only: client reach / engagement summary over a trailing window
export async function engagementSummary(days: number = 30) {
  const since = new Date(Date.now() - days * 864e5);

  const [sessions, pageviews, scrollEvents, sessionEnds, totalUsers, activeUsers] = await Promise.all([
    prisma.session.findMany({ where: { createdAt: { gte: since } }, select: { userId: true, createdAt: true } }),
    prisma.analyticsEvent.findMany({ where: { type: "PAGEVIEW", createdAt: { gte: since } }, select: { userId: true, path: true, createdAt: true } }),
    prisma.analyticsEvent.findMany({ where: { type: "SCROLL_DEPTH", createdAt: { gte: since } }, select: { userId: true, value: true } }),
    prisma.analyticsEvent.findMany({ where: { type: "SESSION_END", createdAt: { gte: since } }, select: { userId: true, value: true } }),
    prisma.user.count({ where: { active: true } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true } }),
  ]);

  const uniqueLoggedInUserIds = new Set(sessions.map((s: any) => s.userId));
  const avgScroll = scrollEvents.length
    ? Math.round(scrollEvents.reduce((sum: number, e: any) => sum + (e.value || 0), 0) / scrollEvents.length)
    : 0;
  // average time-on-page across SESSION_END beacons (seconds); ignore
  // implausible outliers from a tab left open overnight
  const plausible = sessionEnds.filter((e: any) => typeof e.value === "number" && e.value > 0 && e.value < 3 * 3600);
  const avgSessionSeconds = plausible.length
    ? Math.round(plausible.reduce((sum: number, e: any) => sum + e.value, 0) / plausible.length)
    : null;

  // logins per day, last N days (for a simple trend line)
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const loginsByDay: Record<string, number> = {};
  for (const s of sessions) { const k = dayKey(new Date(s.createdAt)); loginsByDay[k] = (loginsByDay[k] || 0) + 1; }
  const trend: { date: string; logins: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const k = dayKey(d);
    trend.push({ date: k, logins: loginsByDay[k] || 0 });
  }

  // pages ranked by views
  const viewsByPath: Record<string, number> = {};
  for (const p of pageviews) { viewsByPath[p.path] = (viewsByPath[p.path] || 0) + 1; }
  const topPages = Object.entries(viewsByPath).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([path, views]) => ({ path, views }));

  // per-user engagement: logins, pageviews, avg scroll depth in the window
  const loginsByUser: Record<string, number> = {};
  for (const s of sessions) { if (s.userId) loginsByUser[s.userId] = (loginsByUser[s.userId] || 0) + 1; }
  const pageviewsByUser: Record<string, number> = {};
  for (const p of pageviews) { if (p.userId) pageviewsByUser[p.userId] = (pageviewsByUser[p.userId] || 0) + 1; }
  const scrollByUser: Record<string, number[]> = {};
  for (const e of scrollEvents) { if (e.userId && typeof e.value === "number") { (scrollByUser[e.userId] ||= []).push(e.value); } }

  const byUser = activeUsers
    .map((u: any) => {
      const logins = loginsByUser[u.id] || 0;
      const views = pageviewsByUser[u.id] || 0;
      const scrolls = scrollByUser[u.id] || [];
      const avg = scrolls.length ? Math.round(scrolls.reduce((a: number, b: number) => a + b, 0) / scrolls.length) : null;
      return { id: u.id, name: u.name, email: u.email, logins, pageviews: views, avgScrollDepth: avg };
    })
    .filter((u: any) => u.logins > 0 || u.pageviews > 0)
    .sort((a: any, b: any) => (b.logins + b.pageviews) - (a.logins + a.pageviews))
    .slice(0, 25);

  return {
    windowDays: days,
    totalUsers,
    activeAccountCount: activeUsers.length,
    uniqueSignedInUsers: uniqueLoggedInUserIds.size,
    totalLogins: sessions.length,
    totalPageviews: pageviews.length,
    avgScrollDepth: avgScroll,
    avgSessionSeconds,
    trend,
    topPages,
    byUser,
  };
}

export { prisma };
