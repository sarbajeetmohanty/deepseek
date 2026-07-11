
-- Add API call limit + denormalized usage counters to user_quotas so
-- quota checks and admin listings are O(1) row reads instead of full-table
-- scans over batches. Backfill from historical batches.

ALTER TABLE public.user_quotas
  ADD COLUMN IF NOT EXISTS api_call_limit bigint,
  ADD COLUMN IF NOT EXISTS questions_used bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS api_calls_used bigint NOT NULL DEFAULT 0;

ALTER TABLE public.user_quotas
  DROP CONSTRAINT IF EXISTS user_quotas_api_call_limit_check;
ALTER TABLE public.user_quotas
  ADD CONSTRAINT user_quotas_api_call_limit_check
  CHECK (api_call_limit IS NULL OR api_call_limit >= 0);

-- Ensure every user with historical batches has a quota row, and seed counters
-- from actual usage so ongoing enforcement is accurate from day one.
INSERT INTO public.user_quotas (user_id, questions_used, api_calls_used)
SELECT b.user_id, COALESCE(SUM(b.total), 0)::bigint, COALESCE(SUM(b.total), 0)::bigint
FROM public.batches b
LEFT JOIN public.user_quotas q ON q.user_id = b.user_id
WHERE q.user_id IS NULL
GROUP BY b.user_id;

UPDATE public.user_quotas q
SET questions_used = COALESCE(sub.total, 0),
    api_calls_used = GREATEST(q.api_calls_used, COALESCE(sub.total, 0))
FROM (SELECT user_id, SUM(total)::bigint AS total FROM public.batches GROUP BY user_id) sub
WHERE q.user_id = sub.user_id
  AND q.questions_used = 0;

-- Cheap index used by admin dashboard aggregates and per-user reads.
CREATE INDEX IF NOT EXISTS idx_batches_user_id ON public.batches(user_id);

-- Atomic increment used by the batch processor and createBatch. Runs as
-- security definer so we can call it from the admin (service-role) client
-- after we've already verified the caller server-side. Not granted to
-- anon/authenticated to prevent users from tampering with their own counters.
CREATE OR REPLACE FUNCTION public.increment_user_usage(
  _user_id uuid,
  _add_questions bigint,
  _add_calls bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_quotas (user_id, questions_used, api_calls_used)
  VALUES (_user_id, GREATEST(_add_questions, 0), GREATEST(_add_calls, 0))
  ON CONFLICT (user_id) DO UPDATE
    SET questions_used = public.user_quotas.questions_used + GREATEST(_add_questions, 0),
        api_calls_used = public.user_quotas.api_calls_used + GREATEST(_add_calls, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.increment_user_usage(uuid, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_user_usage(uuid, bigint, bigint) TO service_role;
