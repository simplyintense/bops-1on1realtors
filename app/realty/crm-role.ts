/**
 * Which 1on1 CRM portal the desk's sidebar copies: the Admin Portal (super_admin, every page) or the Agent Portal (admin, the
 * agent pages). The desk has no CRM roles table, so this reads the desk's own owner flag (viewer.ts, from BOPS_OWNER_EMAILS)
 * and a fixed list of CRM super admins. Only the role name leaves this function; the email is never rendered.
 */

export type CrmRole = "super_admin" | "admin";

/** The CRM super admins who are not desk owners. Lowercase; the check trims and lowercases the signed-in email first. */
export const CRM_SUPER_ADMIN_EMAILS: readonly string[] = [
  "miles@simplyintense.com",
  "wendy@1on1realtors.com",
  "admin@1on1realtors.com",
];

/** A desk owner is always a super admin. Anyone else is a super admin only if their email is on the list above. */
export function crmRole(viewer: { email: string | null; owner: boolean }): CrmRole {
  if (viewer.owner) return "super_admin";
  const email = viewer.email?.trim().toLowerCase() ?? "";
  return email !== "" && CRM_SUPER_ADMIN_EMAILS.includes(email) ? "super_admin" : "admin";
}
