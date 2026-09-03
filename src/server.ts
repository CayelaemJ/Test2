// ════════════════════════════════════════════════════════════════════
//  API SERVER (Fastify + TypeScript)
//  Serves JSON shaped exactly like the frontend DATA / PORTFOLIO objects,
//  so the existing HTML prototype wires up by swapping its constants for
//  fetch() calls — no re-shaping needed.
// ════════════════════════════════════════════════════════════════════

import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import cookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { prisma, snapshotEmployer, getDashboardPayload } from "./services/snapshotBuilder.js";
import { REPORT_FORMATS, LOAD_ORDER, getFormat } from "./services/reportFormats.js";
import { csvTemplate, xlsxTemplate, formatManifest } from "./services/templateGenerator.js";
import { uploadAndValidate, commitBatch, revertBatch, resetAllData } from "./services/importService.js";
import { getConfig as getSyncConfig, saveConfig as saveSyncConfig, publicConfig as publicSyncConfig, testConnection as testSyncConnection, runSync, recentSyncLogs } from "./services/syncService.js";
import { listPartners, createPartner, updatePartner, deletePartner, assignUserToPartner, assignEmployerToPartner, themeForUser, themeForSlug } from "./services/partnerService.js";
import { login, resolveSession, destroySession, canViewEmployer, canAccessModule, allowedEmployerIds, AuthUser } from "./services/authService.js";
import { createUser, listUsers, updateUser, resetPassword, completeSetup, deactivateSelf, listRevokedUsers, deleteUserPermanently, requestPasswordReset } from "./services/userService.js";
import { recordEvent, engagementSummary } from "./services/analyticsService.js";
import { notifyAdmins, notifyScoreChangeIfCurrentPeriod, runStaleAccountCheck, runWeeklyDigestIfDue } from "./services/automationService.js";
import { logAdminAction, listAuditLog } from "./services/auditService.js";
import { exportAuditLogCsv, exportEmployeesCsv, exportDebtAccountsCsv, exportInsurancePoliciesCsv, exportScoreSnapshotsCsv, exportUsersCsv } from "./services/exportService.js";
import { ensureSectionDefaults, listSections, updateSection, grantUserSection, revokeUserSection, sectionsForUser } from "./services/sectionService.js";
import { publicEmailConfig, saveEmailConfig, testEmailConnection, createReportSchedule, listReportSchedules, updateReportSchedule, deleteReportSchedule, sendReportNow, recentReportDeliveries, runDueReports } from "./services/reportScheduler.js";
import type { ScheduleInput } from "./services/reportScheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = [join(__dirname, "public"), join(__dirname, "..", "public")]
  .find((p) => existsSync(join(p, "dashboard.html"))) ?? join(__dirname, "..", "public");

const app = Fastify({ logger: true });

// ── security headers ──
// A conservative baseline that doesn't risk breaking the app's extensive
// use of inline <script>/<style> (a strict CSP without 'unsafe-inline' would
// break nearly every page here, so this isn't attempted blind). Still
// meaningfully hardens against clickjacking, MIME-sniffing, and disables
// browser features this app doesn't use.
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  return payload;
});
app.register(cookie);
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: "/static/",
  // The portal HTML is deployed independently of browser cache state. UI assets
  // are intentionally no-store while the product is pre-live so a deployment
  // cannot appear to retain an older navigation/integration screen.
  setHeaders(res, filePath) {
    if (/\.(?:js|css|html)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
});

const PORT = Number(process.env.PORT ?? 3000);
const currentPeriod = () => new Date().toISOString().slice(0, 7);
const VALID_DASHBOARD_RANGES = new Set(["30d", "quarter", "all", "month", "30", "q", "latest"]);
const VALID_INCOME_BANDS = new Set(["UNDER_5K", "BAND_5_10K", "BAND_10_20K", "BAND_20_40K", "OVER_40K"]);
function dashboardQueryError(query: { period?: string; range?: string; income?: string }): string | null {
  const current = currentPeriod();
  if (query.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.period)) return "period must be YYYY-MM";
  if (query.period && query.period > current) return `period cannot be later than ${current}`;
  if (query.range && !VALID_DASHBOARD_RANGES.has(query.range)) return "range must be 30d, quarter, all or month";
  if (query.period && query.range) return "use period or range, not both";
  if (!query.period && query.range === "month") return "range=month requires period=YYYY-MM";
  if (query.income && query.income !== "all" && !VALID_INCOME_BANDS.has(query.income)) return "income is not a supported income-band code";
  return null;
}
const serveHtml = async (reply: FastifyReply, file: string) =>
  reply
    .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
    .header("Pragma", "no-cache")
    .header("Expires", "0")
    .header("X-Empower-Portal-Build", "0.5.3")
    .type("text/html")
    .send(await readFile(join(PUBLIC_DIR, file), "utf-8"));

// ── auth helpers ──
async function currentUser(req: FastifyRequest): Promise<AuthUser | null> {
  const token = (req.cookies && req.cookies.session) || (req.headers.authorization?.replace("Bearer ", ""));
  return resolveSession(token);
}
// guard for API routes: returns the user or sends 401/403
async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await currentUser(req);
  if (!user) { reply.code(401).send({ error: "not signed in" }); return null; }
  return user;
}
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (user.role !== "ADMIN") { reply.code(403).send({ error: "admin only" }); return null; }
  return user;
}

// ── public pages ──
app.get("/favicon.ico", async (_req, reply) => reply.redirect("/static/favicon.png"));
app.get("/", async (_req, reply) => reply.redirect("/dashboard"));
app.get("/login", async (_req, reply) => serveHtml(reply, "login.html"));
app.get("/set-password", async (_req, reply) => serveHtml(reply, "set-password.html"));
app.get("/privacy", async (_req, reply) => serveHtml(reply, "privacy.html"));
app.get("/terms", async (_req, reply) => serveHtml(reply, "terms.html"));
app.get("/cookies", async (_req, reply) => serveHtml(reply, "cookies.html"));

// ── protected pages: redirect to /login if not allowed ──
app.get("/dashboard", async (req, reply) => {
  const user = await currentUser(req);
  if (!user) return reply.redirect("/login");
  if (!canAccessModule(user, "dashboard")) return reply.redirect("/login");
  return serveHtml(reply, "dashboard.html");
});
app.get("/admin", async (req, reply) => {
  const user = await currentUser(req);
  if (!user) return reply.redirect("/login");
  if (!canAccessModule(user, "admin")) return reply.code(403).type("text/html").send("<h2 style='font-family:sans-serif;padding:40px'>Admins only. <a href='/dashboard'>Go to dashboard</a></h2>");
  return serveHtml(reply, "admin.html");
});
app.get("/users", async (req, reply) => {
  const user = await currentUser(req);
  if (!user || user.role !== "ADMIN") return reply.redirect("/login");
  return serveHtml(reply, "users.html");
});

app.get("/health", async () => ({ ok: true }));
// lets you confirm the NEW build is live: should report the live-dashboard version
app.get("/version", async () => ({ product: "empower-fin Dashboard Portal", version: "0.5.3", contractVersion: "2.6", coreSourceFeeds: 10, sourceModes: ["API", "SQL"], sqlDialects: ["POSTGRESQL", "MSSQL", "MYSQL"], channelPartners: true, scheduledReports: true, emailDelivery: "SMTP", portfolioEmployerFilter: true, portfolioMetricHelp: true, employerMetricHelp: true, uiNavigation: "account-dropdown-v2", routes: ["/login", "/dashboard", "/admin", "/users"] }));

// ════════════════════ AUTH ════════════════════
const COOKIE_SECURE = !["0", "false", "no"].includes(String(process.env.COOKIE_SECURE ?? "true").toLowerCase());
const COOKIE = { httpOnly: true, sameSite: "lax" as const, secure: COOKIE_SECURE, path: "/" };

// ── login brute-force throttle ──
// Simple in-memory lockout per email: after too many wrong passwords in a
// window, further attempts are rejected for a cooldown period. Not a
// substitute for a real distributed rate limiter behind multiple instances,
// but a meaningful improvement over no throttling at all.
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

app.post<{ Body: { email: string; password: string; remember?: boolean } }>("/api/auth/login", async (req, reply) => {
  const { email, password, remember } = req.body ?? ({} as any);
  const key = String(email || "").toLowerCase().trim();
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    return reply.code(429).send({ error: `Too many failed attempts. Try again in ${Math.ceil((rec.lockedUntil - now) / 60000)} minute(s).` });
  }
  const result = await login(email ?? "", password ?? "", !!remember);
  if (!result) {
    const count = (rec && rec.lockedUntil <= now ? rec.count : rec?.count || 0) + 1;
    loginAttempts.set(key, count >= LOGIN_MAX_ATTEMPTS ? { count: 0, lockedUntil: now + LOGIN_LOCKOUT_MS } : { count, lockedUntil: 0 });
    return reply.code(401).send({ error: "invalid email or password" });
  }
  loginAttempts.delete(key);
  // "Remember me": persistent cookie lasting as long as the session (30 days).
  // Otherwise: a session-only cookie (no `expires`) that the browser clears on
  // close, even though the underlying session itself stays valid for 7 days
  // server-side in case the browser doesn't actually close it (e.g. mobile).
  reply.setCookie("session", result.token, remember ? { ...COOKIE, expires: result.expiresAt } : { ...COOKIE });
  return { ok: true, user: { name: result.user.name, role: result.user.role } };
});

app.post("/api/auth/logout", async (req, reply) => {
  await destroySession(req.cookies?.session);
  reply.clearCookie("session", { path: "/" });
  return { ok: true };
});

// who am I + what can I see (drives the UI)
app.get("/api/auth/me", async (req, reply) => {
  const user = await currentUser(req);
  if (!user) return reply.code(401).send({ error: "not signed in" });
  const ids = allowedEmployerIds(user);
  let employers;
  if (ids === null) {
    employers = await prisma.employer.findMany({ where: { sourceDeletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  } else {
    employers = await prisma.employer.findMany({ where: { id: { in: ids }, sourceDeletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  }
  return {
    name: user.name, email: user.email, role: user.role,
    modules: {
      admin: canAccessModule(user, "admin"),
      dashboard: canAccessModule(user, "dashboard"),
      portfolio: canAccessModule(user, "portfolio"),
      users: user.role === "ADMIN",
    },
    sections: await sectionsForUser(user),
    employers,
    theme: await themeForUser(user.id),
  };
});

// complete the set-password link
app.post<{ Body: { token: string; password: string } }>("/api/auth/set-password", async (req, reply) => {
  try {
    const { token, password } = req.body ?? ({} as any);
    if (!password || password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });
    await completeSetup(token, password);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// self-service "forgot password" — always returns { ok: true } regardless of
// whether the email matches an account, so this can't be used to enumerate
// who has an account. A tiny in-memory throttle (per email) stops someone
// from hammering the mail server; it's not a substitute for a real rate
// limiter if you add one later.
const forgotPasswordThrottle = new Map<string, number>();
app.post<{ Body: { email: string } }>("/api/auth/forgot-password", async (req, reply) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  if (!email) return { ok: true };
  const last = forgotPasswordThrottle.get(email) || 0;
  if (Date.now() - last < 60_000) return { ok: true }; // silently no-op if requested <60s ago
  forgotPasswordThrottle.set(email, Date.now());
  try { await requestPasswordReset(email); } catch { /* never leak errors here */ }
  return { ok: true };
});

// ════════════════════ USER MANAGEMENT (admin only) ════════════════════
app.get("/api/users", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return listUsers();
});
app.post<{ Body: { email: string; name: string; role: any; employerIds?: string[]; partnerId?: string; tempPassword?: string; sendSetupLink?: boolean } }>("/api/users", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  try {
    const b = req.body;
    const created = await createUser({
      email: b.email, name: b.name, role: b.role, employerIds: b.employerIds ?? [],
      partnerId: b.partnerId, tempPassword: b.tempPassword, sendSetupLink: b.sendSetupLink, createdBy: admin.email,
    });
    logAdminAction(admin, "user.create", `Created user ${b.name} (${b.email}), role ${b.role}`, { targetType: "User", targetId: (created as any)?.id });
    return created;
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
});
app.patch<{ Params: { id: string }; Body: any }>("/api/users/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  const body: Record<string, any> = { ...(req.body ?? {}) };
  // when an admin flips a user inactive, capture who did it and why for the
  // Past users audit trail (self-service uses a separate endpoint that always
  // records "self")
  if (body.active === false) {
    body.revokedBy = admin.email;
    body.revokedReason = body.reason || body.revokedReason || "Deactivated by admin";
  }
  const updated = await updateUser(req.params.id, body);
  const changedKeys = Object.keys(body).join(", ") || "no fields";
  logAdminAction(admin, "user.update", `Updated user ${req.params.id} (${changedKeys})`, { targetType: "User", targetId: req.params.id, detail: body });
  return updated;
});
app.post<{ Params: { id: string }; Body: { password: string } }>("/api/users/:id/reset-password", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  const result = await resetPassword(req.params.id, req.body.password);
  logAdminAction(admin, "user.reset_password", `Reset password for user ${req.params.id}`, { targetType: "User", targetId: req.params.id });
  return result;
});

// self-service: a signed-in user disables their own account (not a hard delete —
// an admin can still see it under Past users and reactivate it). Ends their
// session immediately, so the response redirects them straight to /login.
app.post<{ Body: { reason?: string } }>("/api/users/me/deactivate", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  await deactivateSelf(user.id, req.body?.reason);
  reply.clearCookie("session", { path: "/" });
  return { ok: true };
});

// admin-only: permanent delete. Requires the account to already be deactivated
// (defence in depth — nobody disappears without first going through revoke).
app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  try {
    const result = await deleteUserPermanently(req.params.id);
    logAdminAction(admin, "user.delete", `Permanently deleted user ${req.params.id}`, { targetType: "User", targetId: req.params.id });
    return result;
  }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// admin-only: "Past users" — everyone currently deactivated, with who revoked
// access and why, so admins can see who once had access and why it ended.
app.get("/api/admin/users/revoked", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return listRevokedUsers();
});

// ════════════════════ ENGAGEMENT ANALYTICS ════════════════════
// Any signed-in user can post their own pageview/scroll beacons. Kept
// intentionally lightweight — no third-party tracking, best-effort (never
// blocks the page if it fails).
app.post<{ Body: { type: "PAGEVIEW" | "SCROLL_DEPTH" | "SESSION_END"; path: string; value?: number } }>(
  "/api/analytics/event",
  async (req, reply) => {
    const user = await currentUser(req); // best-effort — allow anonymous beacons to no-op rather than 401 spam
    const b = req.body ?? ({} as any);
    if (!b.type || !b.path) return reply.code(400).send({ error: "type and path are required" });
    try {
      await recordEvent({ userId: user?.id ?? null, type: b.type, path: b.path, value: b.value, partnerId: (user as any)?.partnerId ?? null });
      return { ok: true };
    } catch { return { ok: true }; } // never fail the page over analytics
  },
);
// admin-only: client reach — active users, logins, pageviews, scroll depth
app.get<{ Querystring: { days?: string } }>("/api/admin/analytics/summary", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
  return engagementSummary(days);
});

// ════════════════════ DASHBOARD SECTION PERMISSIONS (admin only) ════════════════════
// Controls which dashboard sections are visible, and to whom — used to hide a
// section that isn't finished yet (e.g. "Voice of the employee") and to grant
// specific people early access regardless of role.
app.get("/api/admin/sections", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const sections = await listSections();
  return sections.map((s: any) => ({
    key: s.key, label: s.label, enabled: s.enabled,
    allowedRoles: s.allowedRoles.split(",").map((r: string) => r.trim()),
    overrides: s.overrides.map((o: any) => ({ userId: o.userId, name: o.user.name, email: o.user.email })),
  }));
});
app.patch<{ Params: { key: string }; Body: { enabled?: boolean; allowedRoles?: string[] } }>(
  "/api/admin/sections/:key",
  async (req, reply) => {
    const admin = await requireAdmin(req, reply); if (!admin) return;
    try {
      const result = await updateSection(req.params.key, req.body || {});
      logAdminAction(admin, "section.update", `Updated section "${req.params.key}" (${Object.keys(req.body || {}).join(", ") || "no fields"})`, { targetType: "DashboardSection", targetId: req.params.key, detail: req.body });
      return result;
    }
    catch (e: any) { return reply.code(400).send({ error: e?.message || "could not update section" }); }
  },
);
app.post<{ Params: { key: string }; Body: { userId: string } }>(
  "/api/admin/sections/:key/grant",
  async (req, reply) => {
    const admin = await requireAdmin(req, reply); if (!admin) return;
    if (!req.body?.userId) return reply.code(400).send({ error: "userId required" });
    const result = await grantUserSection(req.body.userId, req.params.key);
    logAdminAction(admin, "section.grant", `Granted section "${req.params.key}" to user ${req.body.userId}`, { targetType: "DashboardSection", targetId: req.params.key });
    return result;
  },
);
app.post<{ Params: { key: string }; Body: { userId: string } }>(
  "/api/admin/sections/:key/revoke",
  async (req, reply) => {
    const admin = await requireAdmin(req, reply); if (!admin) return;
    if (!req.body?.userId) return reply.code(400).send({ error: "userId required" });
    const result = await revokeUserSection(req.body.userId, req.params.key);
    logAdminAction(admin, "section.revoke", `Revoked section "${req.params.key}" from user ${req.body.userId}`, { targetType: "DashboardSection", targetId: req.params.key });
    return result;
  },
);

// admin-only: audit log viewer (top N — use ?full=1 for a CSV of everything)
app.get<{ Querystring: { limit?: string } }>("/api/admin/audit-log", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return listAuditLog({ limit: req.query.limit ? parseInt(req.query.limit) : undefined });
});

// admin-only: CSV data export — audit log (full) + the core imported/computed
// datasets. Optional ?employer=<id> scopes to one employer; omitted = everything.
const CSV_EXPORTS: Record<string, (employerId?: string) => Promise<string>> = {
  "audit-log": () => exportAuditLogCsv(),
  employees: (id) => exportEmployeesCsv(id),
  "debt-accounts": (id) => exportDebtAccountsCsv(id),
  "insurance-policies": (id) => exportInsurancePoliciesCsv(id),
  "score-snapshots": (id) => exportScoreSnapshotsCsv(id),
  users: () => exportUsersCsv(),
};
app.get<{ Params: { type: string }; Querystring: { employer?: string } }>(
  "/api/admin/export/:type",
  async (req, reply) => {
    const admin = await requireAdmin(req, reply); if (!admin) return;
    const fn = CSV_EXPORTS[req.params.type];
    if (!fn) return reply.code(404).send({ error: "unknown export type" });
    const csv = await fn(req.query.employer);
    logAdminAction(admin, "data.export", `Exported ${req.params.type} CSV${req.query.employer ? ` (employer ${req.query.employer})` : " (all employers)"}`, { targetType: "Export" });
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="${req.params.type}_${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(csv);
  },
);

// ════════════════════ ADMIN MODULE ════════════════════

// list every report format + load order (admin UI renders from this)
app.get("/api/admin/reports", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return { loadOrder: LOAD_ORDER, reports: formatManifest(REPORT_FORMATS) };
});

// download a blank template (?fmt=csv|xlsx)
app.get<{ Params: { key: string }; Querystring: { fmt?: string } }>(
  "/api/admin/reports/:key/template",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const format = getFormat(req.params.key);
    if (!format) return reply.code(404).send({ error: "unknown report" });
    if ((req.query.fmt ?? "csv") === "xlsx") {
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("Content-Disposition", `attachment; filename="${format.key}_template.xlsx"`);
      return reply.send(xlsxTemplate(format));
    }
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="${format.key}_template.csv"`);
    return reply.send(csvTemplate(format));
  },
);

// upload a report file -> parse + validate -> staged batch (NOT yet live)
app.post<{ Params: { key: string } }>(
  "/api/admin/reports/:key/upload",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "no file uploaded" });
      const buffer = await file.toBuffer();
      const { batch, result } = await uploadAndValidate({
        reportKey: req.params.key,
        filename: file.filename,
        buffer,
        uploadedBy: (await currentUser(req))?.email ?? undefined,
      });
      return {
        batchId: batch.id,
        status: batch.status,
        rowCount: result.rowCount,
        errors: result.errors.slice(0, 200),
        errorCount: result.errors.length,
        missingColumns: result.missingColumns,
        unknownColumns: result.unknownColumns,
        preview: result.rows.slice(0, 10),
      };
    } catch (e: any) {
      req.log.error(e);
      return reply.code(400).send({ error: `could not read the file: ${e.message}. Check it's a valid CSV/Excel and that text with commas is wrapped in quotes.` });
    }
  },
);

// commit a validated batch -> writes live + recomputes affected snapshots
app.post<{ Params: { batchId: string } }>(
  "/api/admin/batches/:batchId/commit",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    try {
      return await commitBatch(req.params.batchId);
    } catch (e: any) {
      req.log.error({ err: e, batchId: req.params.batchId }, "import batch commit failed");
      const raw = String(e?.message || "Import commit failed.").replace(/\s+/g, " ").trim();
      const safe = raw.length > 400 ? `${raw.slice(0, 397)}...` : raw;
      return reply.code(500).send({ error: safe || "Import commit failed. Check the deployment logs for details." });
    }
  },
);

// revert a committed batch
app.post<{ Params: { batchId: string } }>(
  "/api/admin/batches/:batchId/revert",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    try {
      return await revertBatch(req.params.batchId);
    } catch (e: any) {
      req.log.warn({ err: e, batchId: req.params.batchId }, "import batch revert rejected");
      return reply.code(409).send({ error: e?.message || "This import cannot be safely reverted." });
    }
  },
);

// import history
app.get("/api/admin/batches", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const batches = await prisma.importBatch.findMany({
    orderBy: { uploadedAt: "desc" },
    take: 100,
    select: {
      id: true, reportKey: true, filename: true, fileFormat: true,
      status: true, rowCount: true, errorCount: true,
      insertedCount: true, updatedCount: true, deletedCount: true,
      uploadedAt: true, committedAt: true, revertedAt: true,
    },
  });
  return batches.map((batch) => {
    const insertOnly = batch.updatedCount === 0 && batch.deletedCount === 0;
    const reversibleReport = ["employers", "ratings", "referrals", "salary_advances"].includes(batch.reportKey);
    const revertable = batch.status === "COMMITTED" && insertOnly && reversibleReport;
    let revertReason = "";
    if (batch.status === "COMMITTED" && !revertable) {
      revertReason = !insertOnly
        ? "This import updated or deleted existing data and cannot be reversed without a prior-state snapshot."
        : "This feed is corrected by a newer source version/tombstone rather than physical rollback.";
    }
    return { ...batch, revertable, revertReason };
  });
});

// ── DANGER: wipe ALL imported data (clean slate for go-live). Admin only,
//    and the body must contain confirm: "RESET" so it can't fire by accident. ──
app.post<{ Body: { confirm?: string } }>("/api/admin/reset-all", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  if ((req.body?.confirm) !== "RESET") {
    return reply.code(400).send({ error: 'confirmation phrase missing — expected confirm: "RESET"' });
  }
  try {
    const result = await resetAllData();
    logAdminAction(admin, "data.reset_all", `Wiped all imported data (clean slate)`, { detail: result });
    return result;
  } catch (e: any) {
    req.log.error({ err: e }, "reset all imported data failed");
    return reply.code(500).send({ error: e?.message || "Reset failed." });
  }
});

// ── External integration (API or direct SQL pull & sync) — admin only ──
app.get("/api/admin/integration", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const cfg = await getSyncConfig();
  // Secrets are never returned to the browser; only presence flags are exposed.
  return publicSyncConfig(cfg);
});

app.post<{ Body: {
  enabled?: boolean;
  sourceMode?: string;
  baseUrl?: string | null;
  authToken?: string | null;
  scheduleHours?: number;
  sqlDialect?: string | null;
  sqlHost?: string | null;
  sqlPort?: number | null;
  sqlDatabase?: string | null;
  sqlSchema?: string | null;
  sqlUsername?: string | null;
  sqlPassword?: string | null;
  sqlSsl?: boolean;
  sqlTrustServerCertificate?: boolean;
  sqlViewPrefix?: string | null;
  sqlQueryTimeoutMs?: number;
  sqlMaxRowsPerReport?: number;
} }>(
  "/api/admin/integration",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const cfg = await saveSyncConfig(req.body || {});
    return publicSyncConfig(cfg);
  },
);

app.post<{ Body: Record<string, unknown> }>("/api/admin/integration/test", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return testSyncConnection((req.body || {}) as any);
});

app.post("/api/admin/integration/sync", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return runSync("manual");
});

app.get("/api/admin/integration/logs", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return recentSyncLogs(10);
});


// ── system email / SMTP settings — admin only ──
app.get("/api/admin/email-settings", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return publicEmailConfig();
});
app.post<{ Body: any }>("/api/admin/email-settings", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  try {
    const result = await saveEmailConfig(req.body || {});
    const keys = Object.keys(req.body || {}).filter((k) => k !== "smtpPassword").join(", ") || "no fields";
    logAdminAction(admin, "email_settings.update", `Updated email/automation settings (${keys})`, { targetType: "SystemEmailConfig" });
    return result;
  }
  catch (e: any) { return reply.code(400).send({ error: e?.message || "Could not save email settings" }); }
});
app.post<{ Body: any }>("/api/admin/email-settings/test", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  try { return await testEmailConnection(req.body || {}); }
  catch (e: any) { return reply.code(400).send({ error: e?.message || "Email test failed" }); }
});
// manual "run now" for automations — lets an admin verify config without waiting for the hourly tick
app.post<{ Body: { kind: "stale" | "digest" | "test" } }>("/api/admin/automations/run", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  try {
    const kind = req.body?.kind;
    if (kind === "stale") {
      const r = await runStaleAccountCheck();
      return { ok: true, message: r.ran ? `Checked — ${r.deactivated ?? 0} account(s) auto-deactivated.` : "Not run: no inactivity threshold is set." };
    }
    if (kind === "digest") {
      const r = await runWeeklyDigestIfDue();
      return { ok: true, message: r.ran ? "Digest sent." : "Not sent: digest is disabled, or one was already sent in the last 7 days." };
    }
    if (kind === "test") {
      const r = await notifyAdmins({ subject: "Test alert from empower-fin Dashboard Portal", html: `<p>This is a test alert triggered by ${admin.name} (${admin.email}).</p>`, slackText: `:wave: Test alert triggered by ${admin.name}.` });
      return { ok: true, message: `Sent to ${r.emailed} email address(es)${r.slack ? " and Slack" : ""}. Set admin alert emails and/or a Slack webhook first if nothing arrived.` };
    }
    return reply.code(400).send({ error: "Unknown automation kind" });
  } catch (e: any) { return reply.code(400).send({ error: e?.message || "Could not run automation" }); }
});
app.get("/api/admin/report-deliveries", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return recentReportDeliveries(30);
});
app.get("/api/admin/report-schedules", async (req, reply) => {
  const user = await requireAdmin(req, reply); if (!user) return;
  return listReportSchedules(user, true);
});

// ── scheduled employer reports — available to signed-in dashboard users ──
app.get("/api/report-schedules/config", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  const cfg = await publicEmailConfig();
  return { configured: cfg.configured, defaultTimezone: cfg.defaultTimezone };
});
app.get("/api/report-schedules", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  return listReportSchedules(user, false);
});
app.post<{ Body: ScheduleInput }>("/api/report-schedules", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  try { return await createReportSchedule(user, req.body); }
  catch (e: any) { return reply.code(400).send({ error: e?.message || "Could not create report schedule" }); }
});
app.patch<{ Params: { id: string }; Body: any }>("/api/report-schedules/:id", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  try { return await updateReportSchedule(user, req.params.id, req.body || {}); }
  catch (e: any) { return reply.code(400).send({ error: e?.message || "Could not update report schedule" }); }
});
app.delete<{ Params: { id: string } }>("/api/report-schedules/:id", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  try { return await deleteReportSchedule(user, req.params.id); }
  catch (e: any) { return reply.code(400).send({ error: e?.message || "Could not delete report schedule" }); }
});
app.post<{ Params: { id: string } }>("/api/report-schedules/:id/send-now", async (req, reply) => {
  const user = await requireUser(req, reply); if (!user) return;
  try { return await sendReportNow(user, req.params.id); }
  catch (e: any) { return reply.code(400).send({ error: e?.message || "Could not send report" }); }
});

// ── channel partners (white-label) — admin only ──
app.get("/api/admin/partners", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return listPartners();
});
app.post<{ Body: { name: string; displayName?: string } }>("/api/admin/partners", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  if (!req.body?.name?.trim()) return reply.code(400).send({ error: "partner name required" });
  const created = await createPartner(req.body);
  logAdminAction(admin, "partner.create", `Created channel partner "${req.body.name}"`, { targetType: "Partner", targetId: (created as any)?.id });
  return created;
});
app.put<{ Params: { id: string }; Body: any }>("/api/admin/partners/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  const updated = await updatePartner(req.params.id, req.body || {});
  const keys = Object.keys(req.body || {}).join(", ") || "no fields";
  logAdminAction(admin, "partner.update", `Updated channel partner ${req.params.id} (${keys})`, { targetType: "Partner", targetId: req.params.id });
  return updated;
});
app.delete<{ Params: { id: string } }>("/api/admin/partners/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply); if (!admin) return;
  const result = await deletePartner(req.params.id);
  logAdminAction(admin, "partner.delete", `Deleted channel partner ${req.params.id}`, { targetType: "Partner", targetId: req.params.id });
  return result;
});
app.post<{ Params: { id: string }; Body: { userId?: string; employerId?: string } }>(
  "/api/admin/partners/:id/assign",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (req.body?.userId) return assignUserToPartner(req.body.userId, req.params.id);
    if (req.body?.employerId) return assignEmployerToPartner(req.body.employerId, req.params.id);
    return reply.code(400).send({ error: "userId or employerId required" });
  },
);
// public: theme by slug (for the future branded login page)
app.get<{ Params: { slug: string } }>("/api/partner-theme/:slug", async (req) => {
  return themeForSlug(req.params.slug);
});

// ── dashboard: real stock/as-at + flow/in-window filtering ──
app.get<{
  Params: { employerId: string };
  Querystring: { period?: string; range?: "30d" | "quarter" | "all" | "month" | "30" | "q" | "latest"; site?: string; income?: string };
}>(
  "/api/employers/:employerId/dashboard",
  async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { employerId } = req.params;
    if (!canViewEmployer(user, employerId)) return reply.code(403).send({ error: "no access to this employer" });
    const queryError = dashboardQueryError(req.query);
    if (queryError) return reply.code(400).send({ error: queryError });
    const payload: any = await getDashboardPayload(employerId, {
      period: req.query.period,
      range: req.query.range,
      site: req.query.site,
      income: req.query.income,
    });
    const sections = await sectionsForUser(user);
    if (!sections.voiceOfEmployee) payload.chat = { available: false };
    return payload;
  },
);

// ── available months (periods) for the month picker, scoped to access ──
app.get<{ Params: { employerId: string } }>(
  "/api/employers/:employerId/periods",
  async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    if (!canViewEmployer(user, req.params.employerId)) return reply.code(403).send({ error: "no access" });
    const snaps = await prisma.scoreSnapshot.findMany({
      where: { employerId: req.params.employerId, payloadVersion: { gte: 3 } },
      orderBy: { period: "desc" },
      select: { period: true, optimiseScore: true },
    });
    return snaps;
  },
);

// ── score history (movement chart) — scoped ──
app.get<{ Params: { employerId: string } }>(
  "/api/employers/:employerId/score-history",
  async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    if (!canViewEmployer(user, req.params.employerId)) return reply.code(403).send({ error: "no access" });
    return prisma.scoreSnapshot.findMany({
      where: { employerId: req.params.employerId, payloadVersion: { gte: 3 } },
      orderBy: { period: "asc" },
      select: { period: true, optimiseScore: true, engagementScore: true, cashflowScore: true, debtRiskScore: true, insuranceScore: true },
    });
  },
);

// ── trigger a (re)snapshot — admin only ──
app.post<{ Params: { employerId: string }; Body: { period: string } }>(
  "/api/employers/:employerId/snapshot",
  async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const result = await snapshotEmployer(req.params.employerId, req.body.period);
    if (result.persisted) notifyScoreChangeIfCurrentPeriod(req.params.employerId, result.period, currentPeriod()).catch(() => {});
    return result;
  },
);

// ── first-run: create an admin from env vars if no users exist ──
async function bootstrapAdmin() {
  try {
    const count = await prisma.user.count();
    if (count > 0) return;
    const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      app.log.warn("No users yet and ADMIN_EMAIL/ADMIN_PASSWORD not set — set them to create the first admin.");
      return;
    }
    const { hashPassword } = await import("./services/authService.js");
    await prisma.user.create({ data: { email: email.toLowerCase(), name: "Administrator", role: "ADMIN", passwordHash: hashPassword(password) } });
    app.log.info(`Bootstrapped first admin: ${email}`);
  } catch (e) { app.log.error(e); }
}

// ── scheduled-sync checker: every 15 min, run a sync if one is due ──
function startSyncScheduler(app: any) {
  const CHECK_MS = 15 * 60 * 1000;
  const tick = async () => {
    try {
      const cfg = await getSyncConfig();
      if (!cfg.enabled) return;
      const dueAfter = cfg.lastSyncAt ? new Date(cfg.lastSyncAt).getTime() + cfg.scheduleHours * 3600 * 1000 : 0;
      if (Date.now() >= dueAfter) {
        app.log.info("Running scheduled external source sync…");
        const r = await runSync("scheduled");
        app.log.info(`Scheduled sync: ${r.status ?? "done"}`);
        if (r.status === "FAILED") {
          notifyAdmins({
            subject: "Scheduled data sync failed",
            html: `<div style="font-family:Arial,sans-serif;color:#241536"><h2 style="color:#b5391f">Sync failed</h2><p>The scheduled external data sync failed.</p><pre style="background:#f7fafd;padding:12px;border-radius:8px;font-size:12px;overflow:auto">${JSON.stringify(r.summary ?? r, null, 2).slice(0, 2000)}</pre></div>`,
            slackText: `:rotating_light: Scheduled data sync failed — check Administration → Live Data Integration.`,
          }).catch(() => {});
        }
      }
    } catch (e) { app.log.error(e); }
  };
  setInterval(tick, CHECK_MS);
  setTimeout(tick, 30000); // also check shortly after boot
}


// ── automations checker: stale-account cleanup + weekly digest ──
function startAutomationScheduler(app: any) {
  const CHECK_MS = 60 * 60 * 1000; // hourly is plenty — both checks are self-gated by date thresholds
  const tick = async () => {
    try { await runStaleAccountCheck(); } catch (e) { app.log.error(e); }
    try { await runWeeklyDigestIfDue(); } catch (e) { app.log.error(e); }
  };
  setInterval(tick, CHECK_MS);
  setTimeout(tick, 45000);
}

// ── scheduled-report checker: claims due jobs in the database and sends them via SMTP ──
function startReportScheduler(app: any) {
  const CHECK_MS = 60 * 1000;
  const tick = async () => {
    try { await runDueReports(app.log); }
    catch (e) { app.log.error(e); }
  };
  setInterval(tick, CHECK_MS);
  setTimeout(tick, 20000);
}

// ── portfolio view: same dated calculation model as each employer dashboard ──
app.get<{ Querystring: { period?: string; range?: "30d" | "quarter" | "all" | "month" | "30" | "q" | "latest" } }>(
  "/api/portfolio",
  async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    if (!canAccessModule(user, "portfolio")) return reply.code(403).send({ error: "no portfolio access" });
    const queryError = dashboardQueryError(req.query);
    if (queryError) return reply.code(400).send({ error: queryError });
    const ids = allowedEmployerIds(user);
    const employers = await prisma.employer.findMany({
      where: ids === null ? { sourceDeletedAt: null } : { id: { in: ids }, sourceDeletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const out = [];
    let filterContext: unknown = null;
    for (const employer of employers) {
      const payload: any = await getDashboardPayload(employer.id, req.query);
      filterContext ??= payload.filterContext;
      out.push({ id: employer.id, name: employer.name, heads: payload.headcount, ...payload.portfolio });
    }
    return { employers: out, filterContext, generatedAt: new Date().toISOString() };
  },
);

// ── convenience: live dashboard of the first employer THIS USER can see ──
app.get<{ Querystring: { period?: string; range?: "30d" | "quarter" | "all" | "month" | "30" | "q" | "latest"; site?: string; income?: string } }>(
  "/api/dashboard/first",
  async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const queryError = dashboardQueryError(req.query);
    if (queryError) return reply.code(400).send({ error: queryError });
    const ids = allowedEmployerIds(user);
    const employer = await prisma.employer.findFirst({
      where: ids === null ? { sourceDeletedAt: null } : { id: { in: ids }, sourceDeletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true },
    });
    if (!employer) return reply.code(404).send({ error: "no employer data available" });
    const payload: any = await getDashboardPayload(employer.id, req.query);
    const sections = await sectionsForUser(user);
    if (!sections.voiceOfEmployee) payload.chat = { available: false };
    return payload;
  },
);

// Register all routes before opening the listener.
app.log.info({ portalVersion: "0.5.3", publicDir: PUBLIC_DIR }, "starting empower-fin Dashboard Portal");
app.listen({ port: PORT, host: "0.0.0.0" })
  .then(async () => { await bootstrapAdmin(); await ensureSectionDefaults(); startSyncScheduler(app); startReportScheduler(app); startAutomationScheduler(app); app.log.info(`empower-fin Dashboard Portal on :${PORT}`); })
  .catch((err) => { app.log.error(err); process.exit(1); });

