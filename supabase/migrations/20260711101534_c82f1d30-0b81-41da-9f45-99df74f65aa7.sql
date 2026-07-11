CREATE INDEX IF NOT EXISTS idx_questions_batch_status ON public.questions (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_questions_batch_idx ON public.questions (batch_id, idx);
CREATE INDEX IF NOT EXISTS idx_batches_user_created ON public.batches (user_id, created_at DESC);