# Changelog

## 0.5.0

- Manifest: all 20 tools have a `capabilities:` entry with `side_effects` (spec 2042 plugin boundary): 11 `read`, 9 `write` (calendar create/update, gmail send/draft, sheet write/add_tab/duplicate_tab/batch_update, drive create).
- `compat.core` is now `>=1.78.0 <2.0`.
- Audit: no model access, no persona/AGENT.md; JWT signing uses `node:crypto` (no network), all HTTP goes through `ctx.http`. No code change.
