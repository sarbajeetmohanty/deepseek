# Refactor plan: question type + solution length + bolding + format fidelity

## 1. Input dashboard: type + solution length selectors
File: `src/routes/_authenticated/index.tsx`
- Add two selectors in the new-batch form:
  - **Subject type**: `gk_english` (default, uses existing Hindi MCQ prompt) | `math` (uses new math prompt).
  - **Solution length**: `normal` (default) | `long` (more detailed, more steps).
- Persist both on the `batches` row (new columns `subject_type text`, `solution_length text`) via a migration with proper GRANTs, defaults, and check constraints.
- Pass them through `createBatch` server fn → stored on batch → read by processor.

## 2. Two prompts + step-wise math solutions
File: `src/lib/deepseek.server.ts`
- Keep existing Hindi MCQ prompt as `PROMPT_GK`.
- Add `PROMPT_MATH` built from the user's pasted spec: MS-Word friendly, no brackets around option letters, numbering tight (`1.` not `1 .`), `A.` `B.` `C.` `D.` each on its own line, `Answer` and `Solution` labels, solution in **numbered steps** (not paragraphs), squared exponents rendered as `²`/`³`, output wrapped so it survives copy-paste.
- Both prompts get a `SOLUTION_LENGTH` addendum:
  - `normal`: 2–4 short steps.
  - `long`: 5–10 detailed steps with intermediate calculations and the relevant formula recalled at the top.
- `formatQuestionWithDeepSeek({raw, idx, subjectType, solutionLength})` — pick prompt + append length rule. Keep temperature 0, max_tokens raised to 1600 for `long`.
- `sanitizeAiOutput` stays; add step-line normalizer that turns `Step 1:` / `चरण 1:` into a canonical `1. ` bullet line under `Solution:` and inserts newlines between steps if the model runs them together.

## 3. Batch processor wiring
File: `src/lib/batch-processor.server.ts`
- Load `subject_type`, `solution_length` from the batch row once, pass into `formatQuestionWithDeepSeek`.

## 4. Bold question + bold option letters (docx)
File: `src/lib/docx-export.ts`
- Question line: whole line bold (currently only the number was bold).
- Option lines `A. B. C. D.`: whole line bold.
- Match-column headers already bold; keep. Match items: only the `1.` / `a.` prefix bold, body normal (already correct).
- Solution steps: detect leading `\d+\.` inside the Solution block and render as an indented numbered paragraph so step-wise math solutions look like a list, not a wall of text.
- Keep Answer/Solution label bold + body normal.

## 5. Bold in website preview
File: `src/routes/_authenticated/batch.$id.tsx` (`FormattedOutput`)
- Match docx: whole question line bold, whole option line bold, step lines rendered as an indented list under Solution.

## 6. English docx: same formatting fidelity
File: `src/lib/translate.functions.ts`
- After translation, run the same `normalizeTranslated` + step-normalizer so English output keeps `A./B./C./D.` on separate lines, keeps `Column A:` blocks intact, and keeps numbered solution steps.
- Website English preview (if any) uses the same `FormattedOutput` renderer.

## 7. Speed + API efficiency (no behavior change to caller)
- `batch-processor.server.ts`: keep CONCURRENCY=24; add a small in-batch dedupe — if two questions have identical `raw_text`, reuse the first result instead of re-calling DeepSeek.
- Skip already-`done` rows on retry (already done — verify).
- Counter flush interval already 5; leave.

## 8. Verification
- `tsgo --noEmit` after edits.
- Ask user to run one small math batch + one GK batch to confirm end-to-end.

## Technical notes
- Migration adds `subject_type` and `solution_length` with defaults `'gk_english'` / `'normal'` so existing batches keep working.
- No changes to auth, RLS shape, or table grants beyond adding the two columns (existing policies already cover them).
- No new deps.
