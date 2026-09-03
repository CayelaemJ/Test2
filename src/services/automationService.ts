// ════════════════════════════════════════════════════════════════════
//  AUTOMATIONS
//  - notifyAdmins: best-effort email + Slack alert for key events
//  - runStaleAccountCheck: auto-deactivate accounts inactive too long
//  - runWeeklyDigestIfDue: weekly engagement summary to admins
//  - notifyScoreChange: tell an employer's users when their score moves
//  Everything here is best-effort — a failure never throws back into the
//  caller (a missed Slack ping shouldn't break a sync or a login).
// ════════════════════════════════════════════════════════════════════

import { prisma } from "./authService.js";
import { sendMail } from "./reportScheduler.js";
import { destroyAllSessionsForUser } from "./authService.js";
import { engagementSummary } from "./analyticsService.js";

async function config() {
  return prisma.systemEmailConfig.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}

function alertEmailList(cfg: any): string[] {
  return String(cfg.alertEmails || "").split(",").map((s: string) => s.trim()).filter(Boolean);
}

// sends to configured admin alert emails + a Slack webhook, if either is set.
// Never throws — alerting must never take down the thing it's alerting about.
export async function notifyAdmins(opts: { subject: string; html: string; slackText?: string }) {
  const cfg = await config();
  const emails = alertEmailList(cfg);
  const results = { emailed: 0, slack: false };
  if (emails.length) {
    for (const to of emails) {
      try { await sendMail({ to, subject: opts.subject, html: opts.html }); results.emailed++; }
      catch { /* best-effort per recipient */ }
    }
  }
  if (cfg.alertSlackWebhookUrl) {
    try {
      await fetch(cfg.alertSlackWebhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: opts.slackText || opts.subject }),
      });
      results.slack = true;
    } catch { /* best-effort */ }
  }
  return results;
}

// ── auto-deactivate stale accounts ──
// An active account with no session in `staleDeactivateDays` days is
// deactivated exactly like a manual admin action — kept in Past users,
// reactivatable, never deleted. Disabled unless an admin sets the threshold.
export async function runStaleAccountCheck() {
  const cfg = await config();
  const days = (cfg as any).staleDeactivateDays;
  if (!days || days <= 0) return { ran: false };
  const cutoff = new Date(Date.now() - days * 864e5);

  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, email: true, createdAt: true, sessions: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
  });
  const stale = users.filter((u: any) => {
    const last = u.sessions[0]?.createdAt || u.createdAt; // never logged in → measure from account creation
    return new Date(last).getTime() < cutoff.getTime();
  });

  for (const u of stale) {
    await prisma.user.update({
      where: { id: u.id },
      data: { active: false, revokedAt: new Date(), revokedReason: `Auto-deactivated: no activity for ${days}+ days`, revokedBy: "system (auto)" },
    });
    await destroyAllSessionsForUser(u.id);
  }
  await prisma.systemEmailConfig.update({ where: { id: "default" }, data: { lastStaleCheckAt: new Date() } as any });

  if (stale.length) {
    const rows = stale.map((u: any) => `<li>${u.name} — ${u.email}</li>`).join("");
    await notifyAdmins({
      subject: `${stale.length} account(s) auto-deactivated for inactivity`,
      html: `<div style="font-family:Arial,sans-serif;color:#241536"><h2 style="color:#32217c">Auto-deactivated for inactivity</h2><p>No sign-in for ${days}+ days:</p><ul>${rows}</ul><p style="color:#6b7280;font-size:13px">These are deactivated, not deleted — reactivate any of them from Past users.</p></div>`,
      slackText: `:zzz: ${stale.length} account(s) auto-deactivated for ${days}+ days of inactivity.`,
    });
  }
  return { ran: true, deactivated: stale.length };
}

// ── weekly engagement digest ──
export async function runWeeklyDigestIfDue() {
  const cfg = await config();
  if (!(cfg as any).digestEnabled) return { ran: false };
  const last = (cfg as any).lastDigestSentAt ? new Date((cfg as any).lastDigestSentAt).getTime() : 0;
  if (Date.now() - last < 7 * 864e5) return { ran: false };

  const s = await engagementSummary(7);
  const fmtDuration = (sec: number | null) => sec == null ? "—" : sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
  const topPages = s.topPages.slice(0, 5).map((p: any) => `<li>${p.path} — ${p.views} view(s)</li>`).join("") || "<li>No pageviews this week.</li>";
  const topUsers = s.byUser.slice(0, 5).map((u: any) => `<li>${u.name} — ${u.logins} login(s), ${u.pageviews} pageview(s)</li>`).join("") || "<li>No activity this week.</li>";

  await notifyAdmins({
    subject: "Weekly engagement digest",
    html: `<div style="font-family:Arial,sans-serif;color:#241536;max-width:620px">
      <h2 style="color:#32217c">Last 7 days</h2>
      <p><b>${s.activeAccountCount}</b> active accounts · <b>${s.uniqueSignedInUsers}</b> signed in · <b>${s.totalLogins}</b> logins · <b>${s.totalPageviews}</b> pageviews · avg scroll <b>${s.avgScrollDepth}%</b> · avg time on page <b>${fmtDuration(s.avgSessionSeconds)}</b></p>
      <h3 style="color:#32217c">Most-viewed pages</h3><ul>${topPages}</ul>
      <h3 style="color:#32217c">Most engaged users</h3><ul>${topUsers}</ul>
    </div>`,
    slackText: `:bar_chart: Weekly digest — ${s.activeAccountCount} active accounts, ${s.totalLogins} logins, ${s.totalPageviews} pageviews this week.`,
  });
  await prisma.systemEmailConfig.update({ where: { id: "default" }, data: { lastDigestSentAt: new Date() } as any });
  return { ran: true };
}

// ── score-change notification ──
// Only meaningful for the *current* period — historical backfills should
// never trigger a flood of "your score changed" emails.
export async function notifyScoreChangeIfCurrentPeriod(employerId: string, period: string, currentPeriod: string) {
  const cfg = await config();
  if (!(cfg as any).scoreChangeAlertsEnabled) return { notified: false };
  if (period !== currentPeriod) return { notified: false };

  const [latest, previous, employer] = await Promise.all([
    prisma.scoreSnapshot.findUnique({ where: { employerId_period: { employerId, period } } }),
    prisma.scoreSnapshot.findFirst({ where: { employerId, period: { lt: period } }, orderBy: { period: "desc" } }),
    prisma.employer.findUnique({ where: { id: employerId }, select: { name: true } }),
  ]);
  if (!latest || !previous) return { notified: false }; // need two points to call it a "change"
  const delta = latest.optimiseScore - previous.optimiseScore;
  if (delta === 0) return { notified: false };

  const recipients = await prisma.user.findMany({
    where: { active: true, links: { some: { employerId } } },
    select: { email: true, name: true },
  });
  if (!recipients.length) return { notified: false };

  const direction = delta > 0 ? "increased" : "decreased";
  const arrow = delta > 0 ? "▲" : "▼";
  for (const r of recipients) {
    try {
      await sendMail({
        to: r.email,
        subject: `${employer?.name || "Your employer"}'s Optimise Score ${direction} ${arrow}`,
        html: `<div style="font-family:Arial,sans-serif;color:#241536;max-width:560px">
          <h2 style="color:#32217c">Score ${direction}</h2>
          <p>Hi ${r.name || ""},</p>
          <p>${employer?.name || "Your employer"}'s Optimise Score for ${period} is <b>${latest.optimiseScore}</b> (previously ${previous.optimiseScore} in ${previous.period}) — a change of <b>${delta > 0 ? "+" : ""}${delta}</b>.</p>
          <p style="color:#6b7280;font-size:13px">Sign in to the Dashboard Portal for the full breakdown.</p>
        </div>`,
      });
    } catch { /* best-effort per recipient */ }
  }
  return { notified: true, recipients: recipients.length, delta };
}
