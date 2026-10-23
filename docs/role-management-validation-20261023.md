# AI role management — isolated verification, 2026-10-23

This records development checks, **not a production deployment, live-model test, CLI authorization certificate, or proof of every DSH composition**. The checks changed no installed profile, DSH/native-CLI authentication store, running GUI, or global CLI installation; no live provider or paid inference was used.

## Installed-Host check

- DSH **0.2.1-rc.2**, Node **22.23.4**, Linux x64.
- Command: `pnpm check:management` (the script isolates HOME and credential selectors before importing Host modules).
- **20 checks passed**. Registry metadata fixtures recorded 2 provider-list, 1 model-list and 1 model-info request, **0 inference calls**; child backend activations were fixtures.
- [Structured raw report](<role-management-evidence/host-20261023.raw.json>) and [raw output](<role-management-evidence/host-20261023.raw.txt>).
- Reproducer: [check-role-management-host.mjs](<../scripts/check-role-management-host.mjs>).

### Real components

The check mounts the installed Loader/Include and the source plugin with its real Config schema and actual owning entry metadata, not a namespace override. It uses canonical `ctx.settings`, ConfigEditor, the real profile-file lock, atomic 0600 profile persistence, actual ToolRuntime and inherited tool scopes.

Verified behavior includes default OFF; live ON/OFF without remount; child and captured-tool rejection; bounded CRUD and current-session separation; explicit refresh with a successful future delegation to a newly created role; rejected stale delegate captures; unchanged existing children/other roots/workflow defaults; OFF/UI writes winning the actual queued CAS; one winner from competing same-revision plans; read-only refusal; generic user-fork allowance; and a fresh Loader recovering the saved profile.

### Raw-versus-resolved expression protection

Actual SDK descriptors return **evaluated** role values while the owning Loader entry still holds raw `__jsExpr` syntax. Four synthetic, pure-literal cases demonstrate why resolved values cannot safely be written back as opaque metadata:

1. an opaque nested role field;
2. the roles array itself;
3. the complete configuration root;
4. an inherited data-only bundle whose user override is literal `[]` and has no roles field.

For each unsafe case, the bound raw reader rejects syntax before requesting an SDK settings projection, the source read-only Remote method returns only a fixed status, and the actual UI controller refuses a whole-array mutation while retaining its draft. AI preview and the canonical role writer also refuse the unsafe catalog. Profile and inherited bundle bytes remain unchanged. A literal catalog can still be saved through the guarded UI with the AI gate OFF. An old bound reader cannot address a fresh Loader with the same namespace.

The local Remote entrypoint and actual controller are exercised here; this is **not network RPC transport coverage** by itself.

### Fixture boundaries

Agents, child execution, in-memory KV acknowledgement, LLM metadata, the optional HMR scheduling barrier and the UI form transport adapter are fixtures. The scheduling barrier does not replace the real CAS/file lock. This does **not** establish KV disk durability, live model/backend operation, native CLI filesystem enforcement or production deployment. Inherited bundle data contains only synthetic literal expressions evaluated by the Host for this proof; no native-CLI resource code, key command, real environment secret or user extension is executed.

## Actual HTTP transport

`pnpm check:probe` also passes the new syntax-status method through the installed **client Connection → owner-cookie loopback HTTP → Typert Gateway → source Remote service** using the production endpoint and `args.request.expectedRevision` payload. This closes the local-method-only transport boundary above. [Raw HTTP output](<role-management-evidence/http-20261023.raw.txt>); [reproducer](<../scripts/check-probe-host.mjs>).

It verifies a positive Gate-OFF literal status at the canonical revision, stale/unsafe/forged-namespace refusal without source disclosure, correct argument dispatch, ownerless 401 and cross-origin 403, and missing/unavailable/disposed/unloaded service refusal. The single ephemeral listener and owner credential store are test fixtures, not the running GUI or an installed profile. Syntax data is a tiny read-only fixture in this transport check; actual raw/inherited-profile behavior is established separately by the 20-check Loader run.

## Regression and distribution checks

Final local lint, all three TypeScript configurations, **42 suites / 1,346 tests**, and the distribution build pass. The installed workflow regression has **15 passing checks**. The existing source/built bootstrap sandbox check also passes but reports **partial Landlock enforcement and shared existing-hardlink writes**; this is not inode isolation or expanded native-CLI qualification.

`pnpm test` runs Vitest in a disposable HOME with credential selectors stripped, preventing ordinary plugin-startup housekeeping from touching the operator's configuration. Tests cover command validation/repair separation, unknown literal metadata preservation, caller policy/owner checks, CAS/replay/expiration, raw expression refusal, catalog provenance/cancellation/invalidation, UI attestation/connection generations, and lifecycle races.

Current-session lifecycle regressions pause candidate and rollback writes to verify that generic forks and same-session replacement Agents see only the prior committed catalog; replacement refreshes remain busy until the old operation settles; unload awaits rollback and handle close; disposed/unloaded owners cannot start a native child after delayed model validation; and catalog epoch changes do not cancel an already-admitted old-role delegation.

The final lint/type/test/build/package command results are recorded in the pull request. These checks do not install the package into the running DSH instance.
