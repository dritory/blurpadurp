-- Add a config switch for which client the scorer uses. Defaults to
-- "anthropic" so existing deployments keep behaving identically until
-- an operator flips it. "openai_compat" routes through the new
-- OpenAI-compatible client (src/ai/openai-client.ts), which works
-- with DeepSeek, Gemini's compat endpoint, OpenRouter, local
-- vLLM/Ollama — anything that speaks OpenAI's chat/completions API.
--
-- The base URL + API key for the compat client live in env vars
-- (OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY) — secrets don't
-- belong in the config table.
--
-- Recommended validation flow before flipping:
--   1. bun run cli fixture-capture 200          # lock Haiku baseline
--   2. export OPENAI_COMPAT_BASE_URL=https://api.deepseek.com
--      export OPENAI_COMPAT_API_KEY=sk-...
--   3. bun run cli fixture-replay <input.jsonl> docs/scoring-prompt.md \
--        prompt-v0.2 deepseek-chat openai_compat
--   4. Compare diff summary: gate flips, composite Δ, error rate.
--   5. UPDATE config SET value = '"openai_compat"'::jsonb
--      WHERE key = 'scorer.client';
--      UPDATE config SET value = '"deepseek-chat"'::jsonb
--      WHERE key = 'scorer.model_id';

INSERT INTO config (key, value) VALUES
  ('scorer.client', '"anthropic"'::jsonb)
ON CONFLICT (key) DO NOTHING;
