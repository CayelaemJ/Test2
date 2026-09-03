import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import { prisma, getDashboardPayload } from "./snapshotBuilder.js";
import { themeForEmployer } from "./partnerService.js";

export type ReportFilters = {
  period?: string;
  range?: "30d" | "quarter" | "all";
  site?: string;
  income?: string;
};

type EmailDraft = {
  emailProvider?: "smtp" | "resend" | null;
  resendApiKey?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean;
  smtpRequireTls?: boolean;
  smtpRejectUnauthorized?: boolean;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  defaultTimezone?: string | null;
  portalBaseUrl?: string | null;
  alertEmails?: string | null;
  alertSlackWebhookUrl?: string | null;
  digestEnabled?: boolean;
  staleDeactivateDays?: number | null;
  scoreChangeAlertsEnabled?: boolean;
};

export type ScheduleInput = {
  employerId: string;
  name?: string;
  frequency: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
  timezone?: string;
  sendTime?: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  onceDate?: string | null;
  filters?: ReportFilters;
  recipients?: string[];
};

const boolEnv = (name: string): boolean | undefined => {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
};
const clean = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const emailOk = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

export async function getEmailConfig() {
  return prisma.systemEmailConfig.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}

function withEnv(cfg: any, draft: EmailDraft = {}) {
  const pick = <T>(draftValue: T | undefined, envValue: T | undefined, savedValue: T): T =>
    draftValue !== undefined ? draftValue : envValue !== undefined ? envValue : savedValue;
  const draftString = (key: keyof EmailDraft) => draft[key] === undefined ? undefined : clean(draft[key]);
  const envString = (name: string) => process.env[name] === undefined ? undefined : clean(process.env[name]);
  const envPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  return {
    smtpHost: pick(draftString("smtpHost") as any, envString("SMTP_HOST") as any, cfg.smtpHost),
    smtpPort: pick(draft.smtpPort ?? undefined, Number.isFinite(envPort) ? envPort : undefined, cfg.smtpPort),
    smtpSecure: pick(draft.smtpSecure, boolEnv("SMTP_SECURE"), cfg.smtpSecure),
    smtpRequireTls: pick(draft.smtpRequireTls, boolEnv("SMTP_REQUIRE_TLS"), cfg.smtpRequireTls),
    smtpRejectUnauthorized: pick(draft.smtpRejectUnauthorized, boolEnv("SMTP_REJECT_UNAUTHORIZED"), cfg.smtpRejectUnauthorized),
    smtpUsername: pick(draftString("smtpUsername") as any, envString("SMTP_USERNAME") as any, cfg.smtpUsername),
    smtpPassword: pick(draftString("smtpPassword") as any, envString("SMTP_PASSWORD") as any, cfg.smtpPassword),
    fromName: pick(draftString("fromName") as any, envString("SMTP_FROM_NAME") as any, cfg.fromName),
    fromEmail: pick(draftString("fromEmail") as any, envString("SMTP_FROM_EMAIL") as any, cfg.fromEmail),
    replyTo: pick(draftString("replyTo") as any, envString("SMTP_REPLY_TO") as any, cfg.replyTo),
    defaultTimezone: pick(draftString("defaultTimezone") as any, envString("REPORT_TIMEZONE") as any, cfg.defaultTimezone),
    portalBaseUrl: pick(draftString("portalBaseUrl") as any, envString("PORTAL_BASE_URL") as any, cfg.portalBaseUrl),
    passwordFromEnvironment: Boolean(envString("SMTP_PASSWORD")),
    emailProvider: pick(draftString("emailProvider") as any, envString("EMAIL_PROVIDER") as any, cfg.emailProvider) || "smtp",
    resendApiKey: pick(draftString("resendApiKey") as any, envString("RESEND_API_KEY") as any, cfg.resendApiKey),
    resendApiKeyFromEnvironment: Boolean(envString("RESEND_API_KEY")),
  };
}

export async function publicEmailConfig() {
  const cfg = await getEmailConfig();
  const resolved = withEnv(cfg);
  return {
    emailProvider: resolved.emailProvider,
    hasResendApiKey: Boolean(resolved.resendApiKey),
    resendApiKeyFromEnvironment: resolved.resendApiKeyFromEnvironment,
    smtpHost: resolved.smtpHost,
    smtpPort: resolved.smtpPort,
    smtpSecure: resolved.smtpSecure,
    smtpRequireTls: resolved.smtpRequireTls,
    smtpRejectUnauthorized: resolved.smtpRejectUnauthorized,
    smtpUsername: resolved.smtpUsername,
    hasPassword: Boolean(resolved.smtpPassword),
    passwordFromEnvironment: resolved.passwordFromEnvironment,
    fromName: resolved.fromName,
    fromEmail: resolved.fromEmail,
    replyTo: resolved.replyTo,
    defaultTimezone: resolved.defaultTimezone,
    portalBaseUrl: resolved.portalBaseUrl,
    configured: resolved.emailProvider === "resend"
      ? Boolean(resolved.resendApiKey && resolved.fromEmail)
      : Boolean(resolved.smtpHost && resolved.smtpPort && resolved.fromEmail && (!resolved.smtpUsername || resolved.smtpPassword)),
    lastTestAt: cfg.lastTestAt,
    lastTestStatus: cfg.lastTestStatus,
    lastTestNote: cfg.lastTestNote,
    updatedAt: cfg.updatedAt,
    // automations — not secret, safe to return as-is
    alertEmails: (cfg as any).alertEmails,
    alertSlackWebhookUrl: (cfg as any).alertSlackWebhookUrl,
    digestEnabled: (cfg as any).digestEnabled,
    lastDigestSentAt: (cfg as any).lastDigestSentAt,
    staleDeactivateDays: (cfg as any).staleDeactivateDays,
    lastStaleCheckAt: (cfg as any).lastStaleCheckAt,
    scoreChangeAlertsEnabled: (cfg as any).scoreChangeAlertsEnabled,
  };
}

export async function saveEmailConfig(input: EmailDraft) {
  const current = await getEmailConfig();
  const data: any = {};
  if ("emailProvider" in input) {
    const p = clean(input.emailProvider);
    if (p && p !== "smtp" && p !== "resend") throw new Error('email provider must be "smtp" or "resend"');
    data.emailProvider = p || "smtp";
  }
  if (clean(input.resendApiKey)) data.resendApiKey = clean(input.resendApiKey);
  if ("smtpHost" in input) data.smtpHost = clean(input.smtpHost);
  if ("smtpPort" in input && input.smtpPort != null) data.smtpPort = Math.max(1, Math.min(65535, Number(input.smtpPort)));
  if ("smtpSecure" in input) data.smtpSecure = Boolean(input.smtpSecure);
  if ("smtpRequireTls" in input) data.smtpRequireTls = Boolean(input.smtpRequireTls);
  if ("smtpRejectUnauthorized" in input) data.smtpRejectUnauthorized = Boolean(input.smtpRejectUnauthorized);
  if ("smtpUsername" in input) data.smtpUsername = clean(input.smtpUsername);
  if (clean(input.smtpPassword)) data.smtpPassword = clean(input.smtpPassword);
  if ("fromName" in input) data.fromName = clean(input.fromName) || "empower-fin Dashboard Portal";
  if ("fromEmail" in input) data.fromEmail = clean(input.fromEmail);
  if ("replyTo" in input) data.replyTo = clean(input.replyTo);
  if ("defaultTimezone" in input) {
    const zone = clean(input.defaultTimezone) || "Africa/Johannesburg";
    if (!DateTime.now().setZone(zone).isValid) throw new Error("default timezone is not a valid IANA timezone");
    data.defaultTimezone = zone;
  }
  if ("portalBaseUrl" in input) data.portalBaseUrl = clean(input.portalBaseUrl);
  if ("alertEmails" in input) data.alertEmails = clean(input.alertEmails);
  if ("alertSlackWebhookUrl" in input) data.alertSlackWebhookUrl = clean(input.alertSlackWebhookUrl);
  if ("digestEnabled" in input) data.digestEnabled = Boolean(input.digestEnabled);
  if ("staleDeactivateDays" in input) {
    const n = input.staleDeactivateDays;
    data.staleDeactivateDays = n == null || Number(n) <= 0 ? null : Math.round(Math.max(7, Math.min(3650, Number(n))));
  }
  if ("scoreChangeAlertsEnabled" in input) data.scoreChangeAlertsEnabled = Boolean(input.scoreChangeAlertsEnabled);
  if (data.fromEmail && !emailOk(data.fromEmail)) throw new Error("from email is not valid");
  if (data.replyTo && !emailOk(data.replyTo)) throw new Error("reply-to email is not valid");
  await prisma.systemEmailConfig.update({ where: { id: current.id }, data });
  return publicEmailConfig();
}

async function smtpTransport(draft: EmailDraft = {}) {
  const saved = await getEmailConfig();
  const cfg = withEnv(saved, draft);
  if (!cfg.smtpHost) throw new Error("SMTP host is required");
  if (!cfg.smtpPort) throw new Error("SMTP port is required");
  if (!cfg.fromEmail || !emailOk(cfg.fromEmail)) throw new Error("A valid From email is required");
  if (cfg.smtpUsername && !cfg.smtpPassword) throw new Error("SMTP password is required when an SMTP username is supplied");
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: Number(cfg.smtpPort),
    secure: Boolean(cfg.smtpSecure),
    requireTLS: Boolean(cfg.smtpRequireTls),
    auth: cfg.smtpUsername ? { user: cfg.smtpUsername, pass: cfg.smtpPassword } : undefined,
    tls: { rejectUnauthorized: Boolean(cfg.smtpRejectUnauthorized) },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  return { transporter, cfg };
}

// Resend (https://resend.com) — a plain HTTPS API call, no SMTP needed.
// Simpler and more reliable than SMTP from most PaaS hosts (including
// Railway), which is why it's offered as an alternative provider.
async function sendViaResend(cfg: any, opts: { to: string; subject: string; html: string; replyTo?: string }) {
  if (!cfg.resendApiKey) throw new Error("Resend API key is required");
  if (!cfg.fromEmail || !emailOk(cfg.fromEmail)) throw new Error("A valid From email is required");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail,
      to: [opts.to],
      reply_to: opts.replyTo || cfg.replyTo || undefined,
      subject: opts.subject,
      html: opts.html,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.message || ""; } catch { /* ignore parse failure */ }
    throw new Error(`Resend API error (${res.status})${detail ? `: ${detail}` : ""}`);
  }
}

// reusable low-level sender — used for scheduled reports AND for one-off
// transactional emails like "set your password" links (see userService.ts).
// Uses the same admin-configured provider (SMTP or Resend) as everything else.
export async function sendMail(opts: { to: string; subject: string; html: string; replyTo?: string }) {
  const saved = await getEmailConfig();
  const cfg = withEnv(saved);
  if (cfg.emailProvider === "resend") {
    await sendViaResend(cfg, opts);
    return;
  }
  const { transporter, cfg: smtpCfg } = await smtpTransport();
  await transporter.sendMail({
    from: { name: smtpCfg.fromName || "empower-fin Dashboard Portal", address: smtpCfg.fromEmail! },
    to: opts.to,
    replyTo: opts.replyTo || smtpCfg.replyTo || undefined,
    subject: opts.subject,
    html: opts.html,
  });
}

export async function portalBaseUrl(): Promise<string | null> {
  const cfg = await publicEmailConfig();
  return clean((cfg as any).portalBaseUrl) || null;
}

export async function testEmailConnection(draft: EmailDraft & { recipient?: string | null }) {
  const recipient = clean(draft.recipient);
  if (!recipient || !emailOk(recipient)) throw new Error("Enter a valid test recipient email");
  const now = new Date();
  const provider = clean(draft.emailProvider) || (await getEmailConfig()).emailProvider || "smtp";
  try {
    if (provider === "resend") {
      const saved = await getEmailConfig();
      const cfg = withEnv(saved, draft);
      await sendViaResend(cfg, {
        to: recipient,
        subject: "empower-fin Dashboard Portal — email test",
        html: `<div style="font-family:Arial,sans-serif;color:#241536;max-width:620px"><h2 style="color:#32217c">Email delivery is working (via Resend)</h2><p>This test was sent successfully by the <strong>empower-fin Dashboard Portal</strong>.</p><p style="color:#6b7280;font-size:13px">${escapeHtml(now.toISOString())}</p></div>`,
      });
    } else {
      const { transporter, cfg } = await smtpTransport(draft);
      await transporter.verify();
      await transporter.sendMail({
        from: { name: cfg.fromName || "empower-fin Dashboard Portal", address: cfg.fromEmail! },
        to: recipient,
        replyTo: cfg.replyTo || undefined,
        subject: "empower-fin Dashboard Portal — email test",
        html: `<div style="font-family:Arial,sans-serif;color:#241536;max-width:620px"><h2 style="color:#32217c">Email delivery is working</h2><p>This test was sent successfully by the <strong>empower-fin Dashboard Portal</strong>.</p><p style="color:#6b7280;font-size:13px">${escapeHtml(now.toISOString())}</p></div>`,
      });
    }
    await prisma.systemEmailConfig.update({ where: { id: "default" }, data: { lastTestAt: now, lastTestStatus: "SUCCESS", lastTestNote: `Test email sent to ${recipient} via ${provider}` } });
    return { ok: true, recipient };
  } catch (error: any) {
    await prisma.systemEmailConfig.update({ where: { id: "default" }, data: { lastTestAt: now, lastTestStatus: "FAILED", lastTestNote: String(error?.message || error).slice(0, 500) } });
    throw error;
  }
}

function parseTime(sendTime: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(sendTime || "");
  if (!match) throw new Error("send time must be HH:MM");
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("send time must be HH:MM");
  return { hour, minute };
}

export function nextRunFor(input: ScheduleInput, after = new Date()): Date {
  const zone = clean(input.timezone) || "Africa/Johannesburg";
  const localNow = DateTime.fromJSDate(after).setZone(zone);
  if (!localNow.isValid) throw new Error("timezone is not valid");
  const { hour, minute } = parseTime(input.sendTime || "08:00");
  let next: DateTime;
  if (input.frequency === "ONCE") {
    const date = clean(input.onceDate);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("send date is required for a one-off report");
    next = DateTime.fromISO(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, { zone });
    if (!next.isValid) throw new Error("send date is invalid");
    if (next <= localNow) throw new Error("send date/time must be in the future");
  } else if (input.frequency === "DAILY") {
    next = localNow.set({ hour, minute, second: 0, millisecond: 0 });
    if (next <= localNow) next = next.plus({ days: 1 });
  } else if (input.frequency === "WEEKLY") {
    const weekday = Number(input.dayOfWeek);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error("weekday must be Monday (1) to Sunday (7)");
    const delta = (weekday - localNow.weekday + 7) % 7;
    next = localNow.plus({ days: delta }).set({ hour, minute, second: 0, millisecond: 0 });
    if (next <= localNow) next = next.plus({ days: 7 });
  } else if (input.frequency === "MONTHLY") {
    const wanted = Number(input.dayOfMonth);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 31) throw new Error("day of month must be between 1 and 31");
    const inMonth = (base: DateTime) => base.set({ day: Math.min(wanted, base.daysInMonth || wanted), hour, minute, second: 0, millisecond: 0 });
    next = inMonth(localNow);
    if (next <= localNow) next = inMonth(localNow.plus({ months: 1 }).startOf("month"));
  } else {
    throw new Error("unsupported report frequency");
  }
  return next.toUTC().toJSDate();
}

function normalizeRecipients(input: unknown, fallbackEmail: string, allowAdditional: boolean): string[] {
  const raw = Array.isArray(input) ? input : [];
  const cleaned = raw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const recipients = allowAdditional ? cleaned : [fallbackEmail.toLowerCase()];
  if (!recipients.length) recipients.push(fallbackEmail.toLowerCase());
  const unique = [...new Set(recipients)];
  if (unique.length > 10) throw new Error("a report can be sent to a maximum of 10 recipients");
  const invalid = unique.find((email) => !emailOk(email));
  if (invalid) throw new Error(`invalid recipient email: ${invalid}`);
  return unique;
}

function cleanFilters(input: any): ReportFilters {
  const filters: ReportFilters = {};
  if (input?.period) {
    if (!/^\d{4}-\d{2}$/.test(String(input.period))) throw new Error("period must be YYYY-MM");
    filters.period = String(input.period);
  } else {
    const range = ["30d", "quarter", "all"].includes(String(input?.range)) ? String(input.range) as ReportFilters["range"] : "all";
    filters.range = range;
  }
  if (input?.site && input.site !== "all") filters.site = String(input.site);
  if (input?.income && input.income !== "all") filters.income = String(input.income);
  return filters;
}

export async function createReportSchedule(user: any, input: ScheduleInput) {
  const mail = await publicEmailConfig();
  if (!mail.configured) throw new Error("Email delivery is not configured. Ask an administrator to complete System Email Setup first.");
  const employer = await prisma.employer.findUnique({ where: { id: input.employerId }, select: { id: true, name: true } });
  if (!employer) throw new Error("employer not found");
  const canSee = user.role === "ADMIN" || (user.links || []).some((link: any) => link.employerId === employer.id);
  if (!canSee) throw new Error("you do not have access to this employer");
  const timezone = clean(input.timezone) || mail.defaultTimezone || "Africa/Johannesburg";
  const frequency = String(input.frequency || "").toUpperCase() as ScheduleInput["frequency"];
  if (!["ONCE", "DAILY", "WEEKLY", "MONTHLY"].includes(frequency)) throw new Error("unsupported report frequency");
  const sendTime = input.sendTime || "08:00";
  const normalized: ScheduleInput = { ...input, frequency, timezone, sendTime };
  const nextRunAt = nextRunFor(normalized);
  const recipients = normalizeRecipients(input.recipients, user.email, user.role === "ADMIN");
  const filters = cleanFilters(input.filters || {});
  return prisma.reportSchedule.create({
    data: {
      userId: user.id,
      employerId: employer.id,
      name: clean(input.name) || `${employer.name} scheduled report`,
      frequency,
      timezone,
      sendTime,
      dayOfWeek: frequency === "WEEKLY" ? Number(input.dayOfWeek) : null,
      dayOfMonth: frequency === "MONTHLY" ? Number(input.dayOfMonth) : null,
      onceDate: frequency === "ONCE" ? DateTime.fromISO(`${input.onceDate}T00:00:00`, { zone: timezone }).toUTC().toJSDate() : null,
      filters: filters as any,
      recipients: recipients as any,
      nextRunAt,
    },
    include: { employer: { select: { id: true, name: true } } },
  });
}

export async function listReportSchedules(user: any, all = false) {
  const where = user.role === "ADMIN" && all ? {} : { userId: user.id };
  return prisma.reportSchedule.findMany({
    where,
    orderBy: [{ active: "desc" }, { nextRunAt: "asc" }],
    include: {
      employer: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function updateReportSchedule(user: any, id: string, patch: any) {
  const current = await prisma.reportSchedule.findUnique({ where: { id }, include: { user: { select: { email: true } } } });
  if (!current) throw new Error("schedule not found");
  if (user.role !== "ADMIN" && current.userId !== user.id) throw new Error("you cannot edit this schedule");
  if (Object.keys(patch || {}).every((key) => ["active"].includes(key))) {
    return prisma.reportSchedule.update({ where: { id }, data: { active: Boolean(patch.active) } });
  }
  throw new Error("To change report filters or frequency, delete the schedule and create a new one.");
}

export async function deleteReportSchedule(user: any, id: string) {
  const current = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!current) return { deleted: true };
  if (user.role !== "ADMIN" && current.userId !== user.id) throw new Error("you cannot delete this schedule");
  await prisma.reportSchedule.delete({ where: { id } });
  return { deleted: true };
}

function money(value: unknown) {
  if (value == null || value === "") return "—";
  return typeof value === "number" ? `R ${value.toLocaleString("en-ZA")}` : String(value);
}

function reportHtml(payload: any, schedule: any, theme: any) {
  const primary = `#${String(theme?.primaryColor || "32217C").replace(/^#/, "")}`;
  const accent = `#${String(theme?.accentColor || "B15BE8").replace(/^#/, "")}`;
  const label = payload.filterContext?.label || "Programme to date";
  const site = payload.filterContext?.site || "All regions";
  const income = payload.filterContext?.incomeLabel || "All income bands";
  const completed = Array.isArray(payload.outcomes) ? payload.outcomes.reduce((sum: number, row: any) => sum + (Number(row.count) || 0), 0) : 0;
  const outcomeRows = (payload.outcomes || []).map((row: any) => `<tr><td style="padding:9px 8px;border-bottom:1px solid #eee">${escapeHtml(row.name)}</td><td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right">${Number(row.count || 0).toLocaleString("en-ZA")}</td><td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:700">${escapeHtml(row.stat)} ${escapeHtml(row.statL)}</td></tr>`).join("");
  const drivers = (payload.wellness?.drivers || []).map((row: any) => `<tr><td style="padding:7px 8px">${escapeHtml(row.name)}</td><td style="padding:7px 8px;text-align:right;font-weight:700">${row.available ? escapeHtml(row.score) : "Data not loaded"}</td></tr>`).join("");
  const warnings = payload.dataQuality?.warnings || [];
  const portalBase = clean((schedule as any).portalBaseUrl);
  const portal = portalBase ? `${portalBase.replace(/\/$/, "")}/dashboard?employer=${encodeURIComponent(schedule.employerId)}` : null;
  return `<!doctype html><html><body style="margin:0;background:#f5f4fa;font-family:Arial,Helvetica,sans-serif;color:#241536"><div style="max-width:760px;margin:0 auto;padding:28px 16px">
    <div style="background:${primary};padding:22px 26px;border-radius:16px 16px 0 0;color:white"><div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#e6dcff;font-weight:700">${escapeHtml(theme?.name || "empower-fin Dashboard Portal")}</div><h1 style="font-size:26px;margin:8px 0 4px">${escapeHtml(payload.employer)} — Financial Wellbeing Report</h1><div style="font-size:13px;color:#e6dcff">${escapeHtml(label)} · ${escapeHtml(site)} · ${escapeHtml(income)}</div></div>
    <div style="background:white;padding:24px 26px;border-radius:0 0 16px 16px;border:1px solid #e8e1f7;border-top:0">
      <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:22px"><tr>
        <td style="padding:12px;background:#f7f4ff;border-radius:10px"><div style="font-size:11px;color:#7c6c8c;text-transform:uppercase;font-weight:700">Wellness score</div><div style="font-size:26px;font-weight:800;color:${primary}">${payload.wellness?.complete && payload.wellness?.score != null ? escapeHtml(payload.wellness.score) + "/100" : "Data incomplete"}</div></td>
        <td width="10"></td><td style="padding:12px;background:#f7f4ff;border-radius:10px"><div style="font-size:11px;color:#7c6c8c;text-transform:uppercase;font-weight:700">Enrolled</div><div style="font-size:26px;font-weight:800;color:${primary}">${payload.kpis?.takeUp?.available ? Number(payload.kpis.takeUp.enrolled || 0).toLocaleString("en-ZA") : "—"}</div></td>
        <td width="10"></td><td style="padding:12px;background:#f7f4ff;border-radius:10px"><div style="font-size:11px;color:#7c6c8c;text-transform:uppercase;font-weight:700">Problems resolved</div><div style="font-size:26px;font-weight:800;color:${primary}">${payload.availability?.journeys ? completed.toLocaleString("en-ZA") : "—"}</div></td>
      </tr></table>
      <h2 style="font-size:17px;color:${primary};margin:0 0 8px">Headline metrics</h2>
      <table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;margin-bottom:22px"><tr><td style="padding:8px">Programme take-up</td><td style="padding:8px;text-align:right;font-weight:700">${payload.kpis?.takeUp?.available ? escapeHtml(payload.kpis.takeUp.pct) + "%" : "Data not loaded"}</td></tr><tr><td style="padding:8px">Actively engaged</td><td style="padding:8px;text-align:right;font-weight:700">${payload.kpis?.activated?.available ? escapeHtml(payload.kpis.activated.pct) + "%" : "Data not loaded"}</td></tr><tr><td style="padding:8px">Cash freed up / month</td><td style="padding:8px;text-align:right;font-weight:700">${payload.kpis?.monthlySaving?.available ? money(payload.kpis.monthlySaving.rand) : "Data not loaded"}</td></tr><tr><td style="padding:8px">Average experience rating</td><td style="padding:8px;text-align:right;font-weight:700">${payload.kpis?.avgRating?.available ? escapeHtml(payload.kpis.avgRating.val) + "/5" : "Data not loaded"}</td></tr></table>
      <h2 style="font-size:17px;color:${primary};margin:0 0 8px">Financial problems resolved</h2>
      ${outcomeRows ? `<table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;margin-bottom:22px"><thead><tr><th style="text-align:left;padding:8px;background:#f7f4ff">Outcome</th><th style="text-align:right;padding:8px;background:#f7f4ff">Completed</th><th style="text-align:right;padding:8px;background:#f7f4ff">Value</th></tr></thead><tbody>${outcomeRows}</tbody></table>` : `<p style="color:#7c6c8c">${payload.availability?.journeys ? "No completed outcomes in this reporting window." : "Journey data not loaded."}</p>`}
      <h2 style="font-size:17px;color:${primary};margin:0 0 8px">Financial Wellness drivers</h2><table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;margin-bottom:22px">${drivers}</table>
      ${warnings.length ? `<div style="border-left:4px solid #d49a25;background:#fff8e8;padding:12px 14px;font-size:12px;color:#6b531f"><strong>Data quality:</strong> ${warnings.map(escapeHtml).join(" ")}</div>` : ""}
      <div style="margin-top:22px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#8a7e93">Generated ${escapeHtml(DateTime.now().setZone(schedule.timezone || "Africa/Johannesburg").toFormat("dd LLL yyyy HH:mm ZZZZ"))}. This is an aggregated employer report; individual employee financial information is not included.</div>
      ${portal ? `<div style="margin-top:14px"><a href="${escapeHtml(portal)}" style="display:inline-block;background:${accent};color:white;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;font-size:12px">Open Dashboard Portal</a></div>` : ""}
    </div></div></body></html>`;
}

async function sendSchedule(scheduleId: string, triggeredBy: "scheduled" | "manual") {
  const schedule = await prisma.reportSchedule.findUnique({
    where: { id: scheduleId },
    include: { employer: { select: { id: true, name: true } }, user: { select: { id: true, email: true, name: true } } },
  });
  if (!schedule) throw new Error("schedule not found");
  const filters = (schedule.filters || {}) as ReportFilters;
  const payload = await getDashboardPayload(schedule.employerId, filters as any);
  const theme = await themeForEmployer(schedule.employerId);
  const { transporter, cfg } = await smtpTransport();
  const recipients = (Array.isArray(schedule.recipients) ? schedule.recipients : [schedule.user.email]).map(String);
  const subject = `${schedule.employer.name} — ${payload.filterContext?.label || "Financial Wellbeing Report"}`;
  const html = reportHtml(payload, { ...schedule, portalBaseUrl: cfg.portalBaseUrl }, theme);
  try {
    await transporter.sendMail({
      from: { name: cfg.fromName || "empower-fin Dashboard Portal", address: cfg.fromEmail! },
      to: recipients,
      replyTo: cfg.replyTo || undefined,
      subject,
      html,
    });
    await prisma.reportDeliveryLog.create({ data: { scheduleId: schedule.id, triggeredBy, status: "SENT", recipients: recipients as any, subject, filters: filters as any } });
    await prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastSentAt: new Date(), lastStatus: "SENT", lastError: null, consecutiveFailures: 0 } });
    return { ok: true, subject, recipients };
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 1000);
    await prisma.reportDeliveryLog.create({ data: { scheduleId: schedule.id, triggeredBy, status: "FAILED", recipients: recipients as any, subject, filters: filters as any, error: message } });
    const failed = schedule.consecutiveFailures + 1;
    // Only an automatic scheduled delivery may move the persisted next-run time
    // into the retry window. A user clicking “Send now” must never alter the
    // schedule they originally configured.
    const retry = triggeredBy === "scheduled" && failed <= 3 ? new Date(Date.now() + 30 * 60 * 1000) : undefined;
    await prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastStatus: "FAILED", lastError: message, consecutiveFailures: failed, ...(retry ? { active: true, nextRunAt: retry } : {}) } });
    throw error;
  }
}

export async function sendReportNow(user: any, id: string) {
  const schedule = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!schedule) throw new Error("schedule not found");
  if (user.role !== "ADMIN" && schedule.userId !== user.id) throw new Error("you cannot send this schedule");
  return sendSchedule(id, "manual");
}

export async function recentReportDeliveries(limit = 20) {
  return prisma.reportDeliveryLog.findMany({ orderBy: { sentAt: "desc" }, take: Math.max(1, Math.min(100, limit)), include: { schedule: { select: { name: true, employer: { select: { name: true } }, user: { select: { name: true, email: true } } } } } });
}

export async function runDueReports(logger?: { info?: Function; error?: Function }) {
  const now = new Date();
  const due = await prisma.reportSchedule.findMany({ where: { active: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" }, take: 25 });
  for (const row of due) {
    try {
      const onceDate = row.onceDate ? DateTime.fromJSDate(row.onceDate).setZone(row.timezone).toISODate() : null;
      const input: ScheduleInput = { employerId: row.employerId, frequency: row.frequency as ScheduleInput["frequency"], timezone: row.timezone, sendTime: row.sendTime, dayOfWeek: row.dayOfWeek, dayOfMonth: row.dayOfMonth, onceDate };
      const next = row.frequency === "ONCE" ? new Date(now.getTime() + 3650 * 864e5) : nextRunFor(input, new Date(now.getTime() + 1000));
      const claim = await prisma.reportSchedule.updateMany({
        where: { id: row.id, active: true, nextRunAt: { lte: now } },
        data: { lastRunAt: now, nextRunAt: next, ...(row.frequency === "ONCE" ? { active: false } : {}) },
      });
      if (!claim.count) continue;
      logger?.info?.({ scheduleId: row.id, name: row.name }, "sending scheduled report");
      await sendSchedule(row.id, "scheduled");
    } catch (error) {
      logger?.error?.({ err: error, scheduleId: row.id }, "scheduled report failed");
    }
  }
  return { checked: due.length };
}
