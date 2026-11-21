# Plan (Sat 2026-11-21 → Sun 2026-11-22)

## Demo
Cook voice note → transcript → `Extraction` (groceries + advance + notes) → `ActionCard[]` (cart with search links/UPI, advance approval, questions) → approve → UPI link. Plus an eval table: the same recordings on a base model vs our harness.

## Eval
- Headline: about 30 self-recorded cook notes + about 60 IndicVoices clips with quantities, hand-labeled in `fixtures/cases` format.
- Metric: grocery-line exact match (item+qty+unit), item-only accuracy, WER per provider.
- Columns: gpt-transcribe / Sarvam / whisper.cpp × {plain GPT, + harness (lexicon, qty normalizer, household context)}.
- Synthetic TTS clips are for regression only, never in headline numbers.

## Timeline (IST)
| Time | Milestone |
|---|---|
| 12:30 | lanes 1-4 start |
| 13:00 | recording script + Instamart spike verdict |
| 15:00 | merge 1 |
| 16:00 | user records voice notes |
| 17:00 | merge 2: pipeline e2e on fixtures |
| 18:00 | user reviews labels |
| 19:00 | merge 3, deploy (Lightsail + Caddy), web lane starts |
| 21:00 | merge 4 |
| 23:00 | feature freeze |
| 01:00 | regression: golden set via HTTP + e2e API test, local and deployed |

## Cut order (first to go → last)
- pipeline: Telugu → whisper.cpp runtime adapter
- actions: Instamart → scheduled delivery stub → memory learning
- indic: Telugu lexicon
- eval: whisper.cpp column → Telugu → fine-grained ablation
- web: memory panel polish → static eval table

## v1.1 (not now)
Live calls (gpt-realtime + telephony), co-founder call → deliverables, health-data diet planning.
