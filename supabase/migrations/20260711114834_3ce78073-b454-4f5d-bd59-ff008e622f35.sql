CREATE OR REPLACE FUNCTION public.get_team_stats()
 RETURNS TABLE(user_id uuid, questions_done bigint, unique_questions bigint, batches_total bigint, documents_downloaded bigint, last_active timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden: admin only';
  END IF;

  RETURN QUERY
  SELECT
    p.id AS user_id,
    COALESCE(qs.done_total, 0)::bigint,
    COALESCE(qs.unique_total, 0)::bigint,
    COALESCE(bs.batches_total, 0)::bigint,
    COALESCE(ds.downloads_total, 0)::bigint,
    GREATEST(bs.last_batch, ds.last_download) AS last_active
  FROM public.profiles p
  LEFT JOIN (
    SELECT b.user_id AS uid,
           count(*) FILTER (WHERE q.status = 'done') AS done_total,
           count(DISTINCT md5(lower(btrim(q.raw_text)))) FILTER (WHERE q.status = 'done') AS unique_total
    FROM public.batches b
    JOIN public.questions q ON q.batch_id = b.id
    GROUP BY b.user_id
  ) qs ON qs.uid = p.id
  LEFT JOIN (
    SELECT b.user_id AS uid,
           count(*) AS batches_total,
           max(b.created_at) AS last_batch
    FROM public.batches b
    GROUP BY b.user_id
  ) bs ON bs.uid = p.id
  LEFT JOIN (
    SELECT d.user_id AS uid,
           count(*) AS downloads_total,
           max(d.created_at) AS last_download
    FROM public.document_downloads d
    GROUP BY d.user_id
  ) ds ON ds.uid = p.id;
END;
$function$;