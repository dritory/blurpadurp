# Migrations

Plain `.sql` files applied in lexical filename order by
`src/db/migrate.ts`. Each file runs once inside a transaction and is
recorded in the `schema_migration` table **by its full filename**.

## Conventions

- **Prefix with the next unused zero-padded number** (`060_`, `061_`, …).
  A few historical numbers collide (`036`, `044`, `047`, `048`, `051`
  each appear twice). It's harmless — both files apply, ordered by the
  rest of the name — but it's confusing. Check `ls migrations | tail`
  and pick a number nobody else has used.
- **Never rename or renumber a migration that has shipped.** Tracking is
  keyed on the exact filename, so renaming an already-applied file makes
  `migrate.ts` treat it as new and re-run it. Add a follow-up migration
  instead.
- **Name the slug for what it does** (`060_drop_orphaned_cadence_config`),
  and open with a comment explaining *why*, matching the existing files.
- **Keep each migration forward-only and idempotent where cheap**
  (`IF NOT EXISTS`, `DELETE … WHERE`). There is no down-migration runner.
