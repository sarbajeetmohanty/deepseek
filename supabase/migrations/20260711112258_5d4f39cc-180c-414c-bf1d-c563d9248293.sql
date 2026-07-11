
CREATE TABLE public.document_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('original','translated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, batch_id, kind)
);

GRANT SELECT, INSERT ON public.document_downloads TO authenticated;
GRANT ALL ON public.document_downloads TO service_role;

ALTER TABLE public.document_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert own downloads" ON public.document_downloads
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users view own downloads" ON public.document_downloads
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Admins view all downloads" ON public.document_downloads
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_document_downloads_user ON public.document_downloads(user_id);
CREATE INDEX idx_document_downloads_batch ON public.document_downloads(batch_id);

-- Aggregated per-member stats for the admin dashboard.
-- SECURITY DEFINER so it can read across all users' rows, but gated to admins only.
CREATE OR REPLACE FUNCTION public.get_team_stats()
RETURNS TABLE (
  user_id uuid,
  questions_done bigint,
  unique_questions bigint,
  batches_total bigint,
  documents_downloaded bigint,
  last_active timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden: admin only';
  END IF;

  RETURN QUERY
  SELECT
    p.id AS user_id,
    COALESCE(q.done_total, 0)::bigint,
    COALESCE(q.unique_total, 0)::bigint,
    COALESCE(b.batches_total, 0)::bigint,
    COALESCE(d.downloads_total, 0)::bigint,
    GREATEST(b.last_batch, d.last_download) AS last_active
  FROM public.profiles p
  LEFT JOIN (
    SELECT b.user_id,
           count(*) FILTER (WHERE q.status = 'done') AS done_total,
           count(DISTINCT md5(lower(btrim(q.raw_text)))) FILTER (WHERE q.status = 'done') AS unique_total
    FROM public.batches b
    JOIN public.questions q ON q.batch_id = b.id
    GROUP BY b.user_id
  ) q ON q.user_id = p.id
  LEFT JOIN (
    SELECT user_id,
           count(*) AS batches_total,
           max(created_at) AS last_batch
    FROM public.batches
    GROUP BY user_id
  ) b ON b.user_id = p.id
  LEFT JOIN (
    SELECT user_id,
           count(*) AS downloads_total,
           max(created_at) AS last_download
    FROM public.document_downloads
    GROUP BY user_id
  ) d ON d.user_id = p.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_team_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_team_stats() TO authenticated;
