-- DRAFT, NOT APPLIED. For review by Miles before anyone runs it on the 1on1 CRM
-- (Supabase project srosspdqrmjfyatajcaq). It changes no existing table, policy or row.
--
-- Why: the Bops bot login (an `admin` in user_roles) can't read crm_clients, because RLS lets only
-- super_admin or the owning agent see a client. Making the bot super_admin would also let it write
-- everything. This gives one named login read-only access to the columns dedupe and matching need,
-- through a view, and nothing else.
--
-- How to undo: DROP VIEW public.bops_crm_clients; DROP TABLE public.bops_readers;

-- 1. Who may read through the view: the bot's auth user only (add its id after the login exists).
CREATE TABLE IF NOT EXISTS public.bops_readers (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bops_readers ENABLE ROW LEVEL SECURITY;
-- No policies: nobody reads or edits it through the API; only the SQL editor (postgres) manages it.
REVOKE ALL ON public.bops_readers FROM anon, authenticated;

-- 2. The view. It runs as its owner (security_invoker = false), so it can see past crm_clients' RLS,
-- and its own WHERE lets only listed readers get rows. No notes or free-text fields.
CREATE OR REPLACE VIEW public.bops_crm_clients
WITH (security_invoker = false, security_barrier = true) AS
SELECT
  c.id, c.agent_id, c.name, c.email, c.phone, c.status, c.source,
  c.is_purchaser, c.is_vendor, c.listing_type,
  c.budget_min, c.budget_max, c.budget_currency,
  c.bedrooms_min, c.bedrooms_max, c.preferred_locations, c.property_types,
  c.move_in_date, c.created_at, c.updated_at
FROM public.crm_clients c
WHERE EXISTS (SELECT 1 FROM public.bops_readers r WHERE r.user_id = auth.uid());

-- Read only, signed-in users only (the WHERE above narrows it to the bot). Views over one table are
-- auto-updatable in Postgres, so take every write privilege away explicitly.
REVOKE ALL ON public.bops_crm_clients FROM anon, authenticated, public;
GRANT SELECT ON public.bops_crm_clients TO authenticated;

-- 3. After creating the bot login (e.g. bops@1on1realtors.com, role admin):
-- INSERT INTO public.bops_readers (user_id, note)
-- SELECT id, 'Bops bot (read-only CRM clients)' FROM auth.users WHERE email = 'bops@1on1realtors.com';

-- Note: Supabase's security advisor flags security-definer views ("security_definer_view"). That is
-- expected here; the WHERE clause is the access check. A SECURITY DEFINER function exposed at
-- /rest/v1/rpc/ is the alternative if a view isn't wanted; realty/crm.ts reads the view name above.
