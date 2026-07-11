
-- 1) user_quotas: per-member cap the admin sets. NULL = unlimited.
CREATE TABLE IF NOT EXISTS public.user_quotas (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  question_limit integer,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_limit_nonneg CHECK (question_limit IS NULL OR question_limit >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_quotas TO authenticated;
GRANT ALL ON public.user_quotas TO service_role;

ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;

-- Each user can read only their own quota.
DROP POLICY IF EXISTS "Users read own quota" ON public.user_quotas;
CREATE POLICY "Users read own quota" ON public.user_quotas
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Admins can read every member's quota.
DROP POLICY IF EXISTS "Admins read all quotas" ON public.user_quotas;
CREATE POLICY "Admins read all quotas" ON public.user_quotas
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Only admins can write. Server fn also enforces admin, but RLS is the last line.
DROP POLICY IF EXISTS "Admins write quotas" ON public.user_quotas;
CREATE POLICY "Admins write quotas" ON public.user_quotas
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 2) Drop the duplicate questions(batch_id, idx) index (kept idx_questions_batch_idx).
DROP INDEX IF EXISTS public.questions_batch_idx;
