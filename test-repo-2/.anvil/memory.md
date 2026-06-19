## Session abc12345 — 2026-06-18
Renamed User type to Account across types.ts, db.ts, auth.ts. Function names (createUser etc.) were intentionally left unchanged per user request. The Account type now includes a `role` field set to `"user"` by default. All imports were updated accordingly.
---
