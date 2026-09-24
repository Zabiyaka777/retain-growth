import type { SupabaseClient } from "@supabase/supabase-js";

// The gate for every admin endpoint. These endpoints read across all orgs with
// the service role, so the org scoping that protects the rest of the app does
// not apply here — this check is the only thing standing between a logged-in
// customer and everyone else's data. It must run on the server, on every call:
// the /admin route guard in the browser is UX, not security.

export interface AdminIdentity {
  userId: string;
  email: string | null;
}

/**
 * Resolves the caller and confirms they are a platform admin.
 * Returns null when they are not — callers must answer 403 and do nothing else.
 */
export async function requirePlatformAdmin(
  supabase: SupabaseClient,
  accessToken: string,
): Promise<AdminIdentity | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return null;

  const { data: admin, error: adminError } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (adminError) {
    // Fail closed: an unreadable membership table must never be treated as
    // "probably fine".
    console.error("platform-admin: membership lookup failed", adminError);
    return null;
  }
  if (!admin) return null;

  return { userId: userData.user.id, email: userData.user.email ?? null };
}

/**
 * Records one cross-org read. Never throws — an audit write that fails is
 * logged, but it must not turn a successful read into an error response.
 */
export async function logAdminAction(
  supabase: SupabaseClient,
  admin: AdminIdentity,
  action: string,
  details: Record<string, unknown> = {},
  orgId: string | null = null,
): Promise<void> {
  const { error } = await supabase.from("admin_audit_log").insert({
    admin_user_id: admin.userId,
    org_id: orgId,
    action,
    details: { ...details, admin_email: admin.email },
  });
  if (error) console.error("platform-admin: audit insert failed", action, error);
}
