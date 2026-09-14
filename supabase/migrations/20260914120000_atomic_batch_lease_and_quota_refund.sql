-- ---------------------------------------------------------------------------
-- 1. Atomic batch lease
--
-- The previous lease was a SELECT followed by an UPSERT from application code.
-- Between those two statements a second server instance could read the same
-- "no live owner" state and also claim the lease, so two workers could process
-- one batch at the same time and double-spend the Gemini pool.
--
-- Doing the read and the write in a single statement makes the claim atomic:
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE (the existing lease has expired or
-- is ours) returns a row only to the caller that actually won.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.try_acquire_batch_lease(
  _batch_id text,
  _worker_id text,
  _duration_ms bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _key text := 'batch_lease_' || _batch_id;
  _now bigint := (EXTRACT(EPOCH FROM now()) * 1000)::bigint;
  _payload text := json_build_object('workerId', _worker_id, 'expiresAt', _now + _duration_ms)::text;
  _won boolean := false;
BEGIN
  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES (_key, _payload, now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now()
    WHERE
      -- Expired lease, unparseable junk, or a lease we already hold.
      COALESCE(
        NULLIF(public.app_settings.value::json ->> 'expiresAt', '')::bigint,
        0
      ) <= _now
      OR public.app_settings.value::json ->> 'workerId' = _worker_id
  RETURNING true INTO _won;

  RETURN COALESCE(_won, false);
EXCEPTION
  WHEN others THEN
    -- A malformed existing value must not wedge the batch permanently.
    UPDATE public.app_settings SET value = _payload, updated_at = now() WHERE key = _key;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_batch_lease(text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_batch_lease(text, text, bigint) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Quota refunds actually refund
--
-- increment_user_usage clamped every delta with GREATEST(_add, 0), so the
-- refund path in deleteBatch - which passes a NEGATIVE question count - was
-- silently discarded and a deleted batch never gave the user their allowance
-- back. Clamp the resulting TOTAL at zero instead of the delta, which keeps the
-- counter from going negative while letting a refund apply.
-- ---------------------------------------------------------------------------
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
    SET questions_used = GREATEST(public.user_quotas.questions_used + _add_questions, 0),
        api_calls_used = GREATEST(public.user_quotas.api_calls_used + _add_calls, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.increment_user_usage(uuid, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_user_usage(uuid, bigint, bigint) TO service_role;
