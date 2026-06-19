# Anvil Project Rules

- Always use `const` over `let` where possible.
- Never modify `utils.ts` directly — it is a shared utility file used across the entire project. Propose changes in a separate PR instead.
- All error messages must include the function name as a prefix (e.g., `"createUser: invalid email"`).
- Session expiry must be enforced in `auth.ts`, not in the calling code.
- Database queries must go through the functions in `db.ts` — no raw SQL or direct client access elsewhere.
