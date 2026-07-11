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