---
name: test-expert
description: Authoritative reference for THIS node's test setup — the test layers it actually ships (unit, component, external, stack), the vitest configs, what runs in CI vs locally, testcontainers/RLS component setup, fake adapters + APP_ENV=test, and the non-obvious gotchas (dotenv CWD trap, skip-gate ordering, never-mock-the-DB). Use whenever writing a new test, deciding "which layer does this belong in", debugging a flaky test or a `.env.test`-not-loading error, running any `pnpm test:*`, working with testcontainers, touching fake adapters, or wondering whether a test runs in CI. This node is a single flat-layout app — not the operator monorepo.
---

# test-expert

Reference desk for writing and debugging tests in **this node** (a single flat-layout app,
`app/` at repo root — not the operator monorepo's `nodes/<node>/` tree). Leads with the
matrix; gotchas follow, because most test failures here trace back to one of a few repeated
mistakes.

Two distinct things get lumped together as "tests":
- **Enforcement** — static checks that fail the build when rules are violated (typecheck,
  lint, format, generate-cleanliness).
- **Test layers** — vitest suites that exercise code behavior.

## What actually runs in CI

`.github/workflows/ci.yaml` runs exactly three jobs on a PR: **`static`**, **`unit`**,
**`component`**. Everything else (external, stack, money) is local-only — there is no CI job
for it. Know which bucket your change lands in before you push.

| CI job        | What it covers                                              | Local command            |
| ------------- | ---------------------------------------------------------- | ------------------------ |
| **static**    | typecheck + lint + format + db generate-clean              | `pnpm check`             |
| **unit**      | the no-infra vitest suites (unit/contract/meta/ports/...)  | `pnpm test` (`test:ci`)  |
| **component** | adapter ↔ real Postgres via testcontainers (incl. RLS)    | `pnpm test:component`    |

`pnpm check` = `check:workflow && db:check && packages:build && typecheck && test:ci`. Run it
once before committing. `pnpm db:check` validates the migration chain (see `schema-update`).

## Test layer matrix

| Layer              | Config                             | Tests live in              | Proves                                   | Infra needed                       | Command                    | In PR CI? |
| ------------------ | ---------------------------------- | -------------------------- | ---------------------------------------- | ---------------------------------- | -------------------------- | --------- |
| **Unit**           | `vitest.config.mts`                | `tests/unit/`              | Pure logic, no I/O                       | None                               | `pnpm test`                | ✅ (unit) |
| **Contract**       | same                               | `tests/contract/`          | Zod shapes vs route handlers             | None (in-memory)                   | `pnpm test`                | ✅        |
| **Meta**           | same                               | `tests/meta/`              | Doc / spec invariants                    | None                               | `pnpm test`                | ✅        |
| **Ports**          | same                               | `tests/ports/`             | Every adapter implements its port        | None                               | `pnpm test`                | ✅        |
| **Security**       | same                               | `tests/security/`          | Auth, RLS, injection guards              | None                               | `pnpm test`                | ✅        |
| **Arch**           | same                               | `tests/arch/`              | Enforcement rules still catch violations | None (subprocess)                  | `pnpm test`                | ✅        |
| **Component**      | `vitest.component.config.mts`      | `tests/component/*.int.test.ts` | Adapter ↔ real Postgres (+ RLS)     | Testcontainers (Docker)            | `pnpm test:component`      | ✅        |
| **Stack**          | `vitest.stack.config.mts`          | `tests/stack/`             | Full HTTP through the running app        | a running test stack + `.env.test` | (config present, no script)| ❌ local  |
| **External**       | `vitest.external.config.mts`       | `tests/external/`          | Real 3rd-party APIs                      | external creds                     | `pnpm test:external`       | ❌        |
| **External money** | `vitest.external-money.config.mts` | `tests/external/money/`    | Real on-chain / real spend               | funded wallet, real keys           | `pnpm test:external:money` | ❌        |

The no-infra suites (unit/contract/meta/ports/security/arch) all run under `pnpm test` via
`vitest.config.mts`'s include globs — there is no separate `test:meta`/`test:contract` script.

## What you can run locally

**No infra:** `pnpm test`, `pnpm typecheck`, `pnpm check`, `pnpm db:check`.
**Needs Docker:** `pnpm test:component` (spins up a testcontainers Postgres per run),
`pnpm test:external` if it touches testcontainers.
**Needs creds / a running stack — usually defer to CI or a human:** `test:external`,
`test:external:money`, the stack lane. Default agent pattern: run unit + component locally
(Docker permitting); for the rest, push and let CI run what it can, or ask a human.

## Picking the right layer — lightest that proves the assertion

- Pure logic, no I/O → **Unit**.
- Shape of an HTTP request/response → **Contract** (Zod round-trip, no server).
- Adapter ↔ real Postgres/Drizzle, or **any RLS / tenant-isolation proof** → **Component**
  (testcontainers). This is where the RLS coverage gate lives — see `schema-update`.
- Full HTTP through middleware/auth/services/DB → **Stack**.
- Real GitHub/LLM/on-chain behavior → **External** / **External money**.

**Never mock the database.** In component/stack tests use testcontainers or the real DB.
Mocked DBs have concealed broken migrations before; the testcontainer overhead is cheap
insurance. If you're about to mock Postgres, write a component test instead.

## The component lane is the RLS gate

`tests/component/setup/testcontainers-postgres.global.ts` provisions a real Postgres with
`provision.sh` (per-node `app_<node>`/`service_<node>` roles), runs migrations as the app
role, then runs catalog-derived preflights: every table with a FK to `users` must have RLS
ENABLED, every ENABLE must also FORCE. A tenant table missing RLS fails the lane before any
test runs. When you add a tenant-scoped table, prove isolation with a 2-account
`*.int.test.ts` under `tests/component/db/`. Full rule: the `schema-update` skill.

## Gotchas — these bite repeatedly

1. **`APP_ENV=test` swaps fakes via the DI container.** Fake adapters live in
   `app/src/adapters/test/*/fake-*.adapter.ts`, wired in `app/src/bootstrap/container.ts`. If
   a component/stack test hits a real external service, it's almost always a missing fake
   wiring in the container, not a test bug.

2. **dotenv path-CWD trap.** A vitest config doing `config({ path: ".env.test" })` resolves
   **relative to CWD**. It works from repo root but silently fails to load when invoked via
   `pnpm --filter @cogni/node-template-app ...` (CWD becomes `app/`). Symptom: skip-gates
   think creds are missing; tests blow up at provider construction. Fix: resolve from
   `__dirname` — `config({ path: path.resolve(__dirname, "../../.env.test") })`.

3. **Skip-gate must precede provider construction.** External tests that build real clients
   must do so *inside* `describe.skipIf(!hasCreds)` or a gated `beforeAll`, never at module
   scope. Module-scope construction throws on missing env → the skip never runs → red instead
   of a clean skip.

4. **Component globalSetup uses `pnpm -w db:migrate:direct`.** The `-w` (workspace root) flag
   matters — without it the migrate script isn't found when globalSetup runs under a filtered
   pnpm CWD. See `app/tests/component/setup/testcontainers-postgres.global.ts`.

5. **Sequence non-parallelism for stateful lanes.** The component + external configs use
   `sequence: { concurrent: false }` + `pool: forks`, `singleFork: true`. Stateful tests
   (one testcontainer DB epoch) race catastrophically in parallel — don't remove this when
   adding a config.

6. **Time budgets.** Unit files <1s, component 5–30s. If a test blows past that, suspect
   missing env (gotcha #2) before genuine slowness.

## When a test is already failing — triage order

1. **Env loaded?** Check the vitest header for `[dotenv] injecting env (N)`. `N=0` → `.env.test`
   didn't load (gotcha #2).
2. **Creds asserted before construction?** Failure inside a provider constructor, not an
   assertion → gotcha #3.
3. **Testcontainer / migrate?** If `db:migrate:direct` errors in component setup, read the
   migration chain (`schema-update`) — a future-dated `when` silently no-ops; a bad RLS
   migration fails the apply.
4. **Shared-state flakiness?** Passes solo, fails in suite → gotcha #5.
5. **Wrong runner?** Hitting a stack/external test locally without the stack/creds → push and
   let CI run what it can.

## Adding a new test — fast recipe

1. Pick the lightest layer that proves the behavior (list above).
2. Drop the file in that layer's dir with the right pattern (`*.test.ts`, or `*.int.test.ts`
   for component).
3. Run that layer's command first (`pnpm test` or `pnpm test:component`), not `pnpm check` —
   fastest feedback.
4. Each vitest config documents its invariants in its header TSDoc; read it if env/infra is
   involved.
5. Finish with `pnpm check` once before committing.

## References
- `app/vitest*.config.mts` — each config's header documents its lane's invariants.
- `app/tests/component/setup/testcontainers-postgres.global.ts` — the RLS/role gate.
- `infra/compose/runtime/postgres-init/provision.sh` — the role/DB provisioner the component
  lane runs (and production uses).
- skills: `schema-update` (migrations + RLS), `validate-candidate` (proving a deploy, not a
  test). `.github/workflows/ci.yaml` is the source of truth for what actually gates a PR.
