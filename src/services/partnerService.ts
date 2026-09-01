// ─────────────────────────────────────────────────────────────────────────
// Channel partners (white-label). Admins create partners, set their branding,
// and assign users + employers to them. A user's theme = their partner's theme.
// ─────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// empower-fin is the default portal brand. Channel partners override these values for their assigned users.
export const DEFAULT_THEME = {
  name: "empower-fin Dashboard Portal",
  primaryColor: "32217C",
  accentColor: "B15BE8",
  navyColor: "330A36",
  logoDataUrl: null as string | null,
  tagline: null as string | null,
};

export async function listPartners() {
  return prisma.partner.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, slug: true, displayName: true,
      primaryColor: true, accentColor: true, navyColor: true,
      tagline: true, active: true, logoDataUrl: true,
      _count: { select: { users: true, employers: true } },
    },
  });
}

export async function createPartner(input: { name: string; displayName?: string }) {
  const base = slugify(input.name);
  let slug = base || "partner";
  let n = 1;
  while (await prisma.partner.findUnique({ where: { slug } })) slug = `${base}-${++n}`;
  return prisma.partner.create({ data: { name: input.name, slug, displayName: input.displayName || input.name } });
}

export async function updatePartner(id: string, patch: any) {
  const data: any = {};
  for (const k of ["name", "displayName", "primaryColor", "accentColor", "navyColor", "logoDataUrl", "tagline", "active"]) {
    if (k in patch) data[k] = patch[k] === "" ? null : patch[k];
  }
  // normalise hex (strip leading #)
  for (const c of ["primaryColor", "accentColor", "navyColor"]) {
    if (typeof data[c] === "string") data[c] = data[c].replace(/^#/, "").toUpperCase();
  }
  return prisma.partner.update({ where: { id }, data });
}

export async function deletePartner(id: string) {
  // unlink users/employers first (don't delete them), then remove the partner
  await prisma.user.updateMany({ where: { partnerId: id }, data: { partnerId: null } });
  await prisma.employer.updateMany({ where: { partnerId: id }, data: { partnerId: null } });
  await prisma.partner.delete({ where: { id } });
  return { deleted: true };
}

export async function assignUserToPartner(userId: string, partnerId: string | null) {
  return prisma.user.update({ where: { id: userId }, data: { partnerId } });
}

export async function assignEmployerToPartner(employerId: string, partnerId: string | null) {
  return prisma.employer.update({ where: { id: employerId }, data: { partnerId } });
}

// resolve the theme that should apply for a given user
export async function themeForUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { partner: true } });
  const p = user?.partner;
  if (!p || !p.active) return { ...DEFAULT_THEME };
  return {
    name: p.displayName || p.name || DEFAULT_THEME.name,
    primaryColor: p.primaryColor || DEFAULT_THEME.primaryColor,
    accentColor: p.accentColor || DEFAULT_THEME.accentColor,
    navyColor: p.navyColor || DEFAULT_THEME.navyColor,
    logoDataUrl: p.logoDataUrl || null,
    tagline: p.tagline || null,
  };
}

// Resolve branding from the employer itself. Scheduled reports should use the
// channel-partner brand assigned to the employer rather than whichever admin
// happened to create the schedule.
export async function themeForEmployer(employerId: string) {
  const employer = await prisma.employer.findUnique({ where: { id: employerId }, include: { partner: true } });
  const p = employer?.partner;
  if (!p || !p.active) return { ...DEFAULT_THEME };
  return {
    name: p.displayName || p.name || DEFAULT_THEME.name,
    primaryColor: p.primaryColor || DEFAULT_THEME.primaryColor,
    accentColor: p.accentColor || DEFAULT_THEME.accentColor,
    navyColor: p.navyColor || DEFAULT_THEME.navyColor,
    logoDataUrl: p.logoDataUrl || null,
    tagline: p.tagline || null,
  };
}

// theme by partner slug (for the future branded login page)
export async function themeForSlug(slug: string) {
  const p = await prisma.partner.findUnique({ where: { slug } });
  if (!p || !p.active) return { ...DEFAULT_THEME };
  return {
    name: p.displayName || p.name,
    primaryColor: p.primaryColor || DEFAULT_THEME.primaryColor,
    accentColor: p.accentColor || DEFAULT_THEME.accentColor,
    navyColor: p.navyColor || DEFAULT_THEME.navyColor,
    logoDataUrl: p.logoDataUrl || null,
    tagline: p.tagline || null,
  };
}
