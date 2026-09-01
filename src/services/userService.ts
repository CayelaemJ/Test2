// ════════════════════════════════════════════════════════════════════
//  USER MANAGEMENT (admin only)
//  Create users with a temp password OR a set-password link, list them,
//  update role/links/active, and complete the set-password flow.
// ════════════════════════════════════════════════════════════════════

import { randomBytes } from "node:crypto";
import { prisma, hashPassword, destroyAllSessionsForUser } from "./authService.js";
import { sendMail, portalBaseUrl } from "./reportScheduler.js";

type Role = "ADMIN" | "EMPLOYER_VIEW" | "PORTFOLIO_VIEW";

export async function createUser(opts: {
  email: string;
  name: string;
  role: Role;
  employerIds: string[];
  partnerId?: string | null;
  tempPassword?: string;   // if provided, account is ready to use
  sendSetupLink?: boolean; // if true, generate a one-time setup token instead
  createdBy?: string;
}) {
  const email = opts.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("a user with that email already exists");

  let passwordHash: string | null = null;
  let setupToken: string | null = null;
  let setupExpires: Date | null = null;

  if (opts.sendSetupLink) {
    setupToken = randomBytes(24).toString("hex");
    setupExpires = new Date(Date.now() + 3 * 864e5); // 3 days
  } else if (opts.tempPassword) {
    passwordHash = hashPassword(opts.tempPassword);
  } else {
    throw new Error("provide either a temporary password or choose to send a setup link");
  }

  const user = await prisma.user.create({
    data: {
      email, name: opts.name, role: opts.role,
      passwordHash, setupToken, setupExpires, createdBy: opts.createdBy,
      partnerId: opts.partnerId || null,
      links: { create: opts.employerIds.map((employerId) => ({ employerId })) },
    },
    include: { links: true },
  });

  // the setup link the admin can copy/send (relative path; prefix with your domain)
  const setupPath = setupToken ? `/set-password?token=${setupToken}` : null;

  // try to email the setup link automatically; if SMTP isn't configured or
  // sending fails for any reason, we don't fail user creation — the admin
  // still gets setupPath back in the response to copy/send manually as a fallback.
  let emailSent = false;
  let emailError: string | null = null;
  if (setupPath) {
    try {
      const base = (await portalBaseUrl()) || "";
      const link = base ? `${base.replace(/\/$/, "")}${setupPath}` : setupPath;
      await sendMail({
        to: email,
        subject: "Set up your empower-fin Dashboard Portal account",
        html: `<div style="font-family:Arial,sans-serif;color:#241536;max-width:620px">
          <h2 style="color:#32217c">You've been added to the Dashboard Portal</h2>
          <p>Hi ${escapeHtml(opts.name || "")},</p>
          <p>An admin has created an account for you. Click below to set your password and log in:</p>
          <p style="margin:24px 0"><a href="${link}" style="background:#32217c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Set your password</a></p>
          <p style="color:#6b7280;font-size:13px">This link expires in 3 days. If the button doesn't work, copy this link: ${link}</p>
        </div>`,
      });
      emailSent = true;
    } catch (e: any) {
      emailError = String(e?.message || e).slice(0, 300);
    }
  }

  return { user: sanitize(user), setupPath, emailSent, emailError };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      links: { include: { employer: { select: { id: true, name: true } } } },
      partner: { select: { id: true, name: true, displayName: true } },
    },
  });
  return users.map((u: any) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, active: u.active,
    hasPassword: !!u.passwordHash,
    pendingSetup: !!u.setupToken,
    employers: u.links.map((l: any) => ({ id: l.employer.id, name: l.employer.name })),
    partner: u.partner ? { id: u.partner.id, name: u.partner.displayName || u.partner.name } : null,
    createdAt: u.createdAt,
  }));
}

export async function updateUser(userId: string, patch: {
  name?: string; role?: Role; active?: boolean; employerIds?: string[]; partnerId?: string | null;
  revokedReason?: string; revokedBy?: string;
}) {
  if (patch.employerIds) {
    // replace links wholesale
    await prisma.userEmployer.deleteMany({ where: { userId } });
    await prisma.userEmployer.createMany({ data: patch.employerIds.map((employerId) => ({ userId, employerId })) });
  }
  // `active` transitions carry a revocation audit trail: who revoked access and
  // why, kept even after re-enabling so history isn't lost. Cleared once the
  // account is reactivated (a fresh deactivation writes a fresh reason).
  const revokeFields: Record<string, unknown> = {};
  if (patch.active === false) {
    revokeFields.revokedAt = new Date();
    revokeFields.revokedReason = patch.revokedReason || "No reason given";
    revokeFields.revokedBy = patch.revokedBy || "admin";
  } else if (patch.active === true) {
    revokeFields.revokedAt = null;
    revokeFields.revokedReason = null;
    revokeFields.revokedBy = null;
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      name: patch.name, role: patch.role as any, active: patch.active,
      ...("partnerId" in patch ? { partnerId: patch.partnerId || null } : {}),
      ...revokeFields,
    },
    include: { links: { include: { employer: { select: { id: true, name: true } } } } },
  });
  if (patch.active === false) await destroyAllSessionsForUser(userId); // end access immediately
  return sanitize(user);
}

// self-service: a user disables their own account. Ends their own session too,
// since the deactivation should take effect immediately.
export async function deactivateSelf(userId: string, reason?: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { active: false, revokedAt: new Date(), revokedReason: reason || "Deactivated by the user", revokedBy: "self" },
  });
  await destroyAllSessionsForUser(userId);
  return sanitize(user);
}

// admin-only: past users — anyone currently inactive, with the revocation audit
// trail, so admins can see who once had access and why it was revoked.
export async function listRevokedUsers() {
  const users = await prisma.user.findMany({
    where: { active: false },
    orderBy: { revokedAt: "desc" },
    include: { partner: { select: { id: true, name: true, displayName: true } } },
  });
  return users.map((u: any) => ({
    id: u.id, email: u.email, name: u.name, role: u.role,
    partner: u.partner ? (u.partner.displayName || u.partner.name) : null,
    createdAt: u.createdAt,
    revokedAt: u.revokedAt, revokedReason: u.revokedReason, revokedBy: u.revokedBy,
  }));
}

// admin-only: permanent delete. Only allowed on an already-deactivated account,
// so nobody is removed without first going through the revoke/audit step.
export async function deleteUserPermanently(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("user not found");
  if (user.active) throw new Error("deactivate the account before deleting it permanently");
  await destroyAllSessionsForUser(userId);
  await prisma.user.delete({ where: { id: userId } });
  return { ok: true };
}

export async function resetPassword(userId: string, newPassword: string) {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(newPassword), setupToken: null, setupExpires: null } });
  return { ok: true };
}

// set-password flow (user clicks the emailed link)
export async function completeSetup(token: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { setupToken: token } });
  if (!user || !user.setupExpires || user.setupExpires < new Date()) {
    throw new Error("this setup link is invalid or has expired");
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(newPassword), setupToken: null, setupExpires: null, active: true },
  });
  return { ok: true };
}

function sanitize(u: any) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, employers: (u.links ?? []).map((l: any) => l.employerId) };
}

export { prisma };
