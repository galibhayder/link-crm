-- ============================================================================
-- 0025 — A verdict for pages the verifier cannot judge
--
-- The verification service reports `link_missing` when no anchor to the target was
-- found in the fetched HTML. That is correct for a server-rendered page and WRONG
-- for a JavaScript shell: a React/Vue/Next page returns a nearly empty document and
-- renders the article — including the backlink — in the browser. Reporting
-- `link_missing` there is a false negative that would send someone to complain to a
-- publisher about a link that is fine.
--
-- A headless browser would answer the question properly, but Chromium cannot run on
-- the Hostinger shared-hosting target and is ~300 MB — an unreasonable dependency
-- for one check. Instead the verifier DETECTS the shell and reports
-- `needs_manual_review`: neither "ok" (we did not find the link) nor "link_missing"
-- (we did not prove it absent).
-- ============================================================================

alter table public.link_checks
  drop constraint if exists link_checks_verdict_check;

alter table public.link_checks
  add constraint link_checks_verdict_check
  check (verdict in (
    'ok',
    'link_missing',
    'url_mismatch',
    'anchor_mismatch',
    'attr_mismatch',
    'unreachable',
    -- The page loaded but could not be judged: it is a JavaScript shell, so the
    -- link may exist after rendering and a human must confirm.
    'needs_manual_review'
  ));

comment on column public.link_checks.verdict is
  'The outcome a human acts on. `needs_manual_review` means the page rendered client-side and could not be judged from server HTML.';
