
-- Roles enum
CREATE TYPE public.app_role AS ENUM ('admin', 'member');

-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- User roles
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- has_role security-definer
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Profile policies
CREATE POLICY "Users see own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Admins see all profiles" ON public.profiles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- User roles policies
CREATE POLICY "Users see own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admins see all roles" ON public.user_roles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Invitations
CREATE TABLE public.invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invitations_email_idx ON public.invitations (lower(email));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO authenticated;
GRANT ALL ON public.invitations TO service_role;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage invitations" ON public.invitations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Batches
CREATE TABLE public.batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  total INT NOT NULL DEFAULT 0,
  completed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.batches TO authenticated;
GRANT ALL ON public.batches TO service_role;
ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own batches" ON public.batches FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins see all batches" ON public.batches FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Questions
CREATE TABLE public.questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  raw_text TEXT NOT NULL,
  formatted_output TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX questions_batch_idx ON public.questions (batch_id, idx);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.questions TO authenticated;
GRANT ALL ON public.questions TO service_role;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own questions" ON public.questions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.batches b WHERE b.id = questions.batch_id AND (b.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))));
CREATE POLICY "Users manage own questions" ON public.questions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.batches b WHERE b.id = questions.batch_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.batches b WHERE b.id = questions.batch_id AND b.user_id = auth.uid()));

-- Auto-create profile + assign role (first user = admin; invited email = member; others = member)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_count INT;
  is_invited BOOLEAN;
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name');

  SELECT count(*) INTO user_count FROM auth.users;
  SELECT EXISTS (SELECT 1 FROM public.invitations WHERE lower(email) = lower(NEW.email) AND status = 'pending') INTO is_invited;

  IF user_count <= 1 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSIF is_invited THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'member');
    UPDATE public.invitations SET status = 'accepted' WHERE lower(email) = lower(NEW.email) AND status = 'pending';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, anon;
CREATE INDEX IF NOT EXISTS idx_questions_batch_status ON public.questions (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_questions_batch_idx ON public.questions (batch_id, idx);
CREATE INDEX IF NOT EXISTS idx_batches_user_created ON public.batches (user_id, created_at DESC);
ALTER TABLE public.batches
ADD COLUMN IF NOT EXISTS subject_type text NOT NULL DEFAULT 'gk_english',
ADD COLUMN IF NOT EXISTS solution_length text NOT NULL DEFAULT 'normal';

ALTER TABLE public.batches
DROP CONSTRAINT IF EXISTS batches_subject_type_check;
ALTER TABLE public.batches
ADD CONSTRAINT batches_subject_type_check CHECK (subject_type IN ('gk_english','math'));

ALTER TABLE public.batches
DROP CONSTRAINT IF EXISTS batches_solution_length_check;
ALTER TABLE public.batches
ADD CONSTRAINT batches_solution_length_check CHECK (solution_length IN ('normal','long'));
-- Lock down SECURITY DEFINER function execution.
-- handle_new_user() only runs from the auth.users insert trigger; nobody should call it via the API.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- has_role() is used inside RLS policies; keep it callable by the roles that own those policies,
-- but remove the broad PUBLIC/anon grants so it isn't callable without a session.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

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

CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only the server (service_role) reads the raw value. Admins can write via a
-- server function that authorizes them, but we still grant UPDATE/INSERT
-- to admins here so the RLS below can gate writes explicitly and the SELECT
-- policy stays admin-only for the "is a key configured / who set it / when"
-- status UI.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read settings" ON public.app_settings
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins insert settings" ON public.app_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins update settings" ON public.app_settings
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins delete settings" ON public.app_settings
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en';

-- Allow users to update their own profile (avatar + language + name).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='Users can update own profile'
  ) THEN
    CREATE POLICY "Users can update own profile" ON public.profiles
      FOR UPDATE TO authenticated
      USING (auth.uid() = id)
      WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- All signed-in users can view avatars (needed to show teammates' photos).
CREATE POLICY "Authenticated can read avatars"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars');

-- Each user can only write/replace/delete objects under their own user id folder.
CREATE POLICY "Users manage own avatar"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

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
