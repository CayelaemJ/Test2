// ════════════════════════════════════════════════════════════════════
//  DASHBOARD SECTION PERMISSIONS
//  Controls visibility of individual dashboard sections independently
//  of the coarser Role / UserEmployer gates in authService.ts.
//
//  Use this to hide a section that isn't finished yet ("Voice of the
//  employee") and to give specific people early/preview access to it
//  regardless of role.
// ════════════════════════════════════════════════════════════════════

import { prisma } from "./authService.js";
import type { AuthUser } from "./authService.js";

// Every section the dashboard knows how to hide. `key` MUST match the
// data-section attribute used in public/dashboard.html.
export const SECTION_DEFS: { key: string; label: string }[] = [
  { key: "valueDelivered", label: "Value delivered to your people" },
  { key: "earlyWageAccess", label: "Early Wage Access" },
  { key: "stressMap", label: "Workforce Financial Stress Map" },
  { key: "problemDebt", label: "How problem debt is being handled" },
  { key: "opportunities", label: "Opportunities identified" },
  { key: "voiceOfEmployee", label: "Voice of the employee" },
];

const ALL_ROLES = "ADMIN,EMPLOYER_VIEW,PORTFOLIO_VIEW";

// idempotent — call at boot so every known section has a config row.
// New sections default to visible; flip `enabled` off manually for
// anything that isn't ready yet (see NEXT_STEPS.md for how to do that
// via /api/admin/sections).
export async function ensureSectionDefaults() {
  for (const def of SECTION_DEFS) {
    await prisma.dashboardSection.upsert({
      where: { key: def.key },
      update: { label: def.label }, // keep the label current if we rename it in code
      create: { key: def.key, label: def.label, enabled: true, allowedRoles: ALL_ROLES },
    });
  }
}

export async function listSections() {
  return prisma.dashboardSection.findMany({
    orderBy: { key: "asc" },
    include: {
      overrides: { include: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
}

export async function updateSection(key: string, patch: { enabled?: boolean; allowedRoles?: string[] }) {
  return prisma.dashboardSection.update({
    where: { key },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.allowedRoles ? { allowedRoles: patch.allowedRoles.join(",") } : {}),
    },
  });
}

export async function grantUserSection(userId: string, sectionKey: string) {
  return prisma.userSectionAccess.upsert({
    where: { userId_sectionKey: { userId, sectionKey } },
    update: {},
    create: { userId, sectionKey },
  });
}

export async function revokeUserSection(userId: string, sectionKey: string) {
  return prisma.userSectionAccess.deleteMany({ where: { userId, sectionKey } });
}

/** { sectionKey: canSeeIt } for this user — drives both the frontend hide/show
 *  and any server-side redaction of that section's data (see server.ts). */
export async function sectionsForUser(user: AuthUser): Promise<Record<string, boolean>> {
  const sections = await prisma.dashboardSection.findMany({
    include: { overrides: { where: { userId: user.id } } },
  });
  const out: Record<string, boolean> = {};
  for (const s of sections) {
    if (user.role === "ADMIN") { out[s.key] = true; continue; } // admins can always preview
    if (s.overrides.length > 0) { out[s.key] = true; continue; } // explicit per-user grant
    const roles = s.allowedRoles.split(",").map((r) => r.trim());
    out[s.key] = s.enabled && roles.includes(user.role);
  }
  return out;
}

export { prisma };
