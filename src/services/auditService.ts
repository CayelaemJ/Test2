// ════════════════════════════════════════════════════════════════════
//  ADMIN AUDIT LOG
//  Every admin-initiated change is recorded here: who, what action, on
//  which record, and a one-line human summary (plus optional structured
//  detail). Logging failures never block the action itself.
// ════════════════════════════════════════════════════════════════════

import { prisma } from "./authService.js";

export async function logAdminAction(
  actor: { email: string; name: string },
  action: string,
  summary: string,
  opts: { targetType?: string; targetId?: string; detail?: unknown } = {},
) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorEmail: actor.email,
        actorName: actor.name,
        action,
        summary,
        targetType: opts.targetType,
        targetId: opts.targetId,
        detail: opts.detail == null ? undefined : (JSON.parse(JSON.stringify(opts.detail))),
      },
    });
  } catch { /* never let logging break the action it's logging */ }
}

export async function listAuditLog(opts: { limit?: number; actorEmail?: string; targetType?: string } = {}) {
  const limit = Math.min(500, Math.max(1, opts.limit || 100));
  return prisma.adminAuditLog.findMany({
    where: {
      ...(opts.actorEmail ? { actorEmail: opts.actorEmail } : {}),
      ...(opts.targetType ? { targetType: opts.targetType } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
