# Role catalog successor validation — 2026-10-24

## Change boundary

This selectively carries [PR13](https://github.com/Aero123421/dsh-rolesubagents/pull/13) onto [the lifecycle successor, PR18](https://github.com/Aero123421/dsh-rolesubagents/pull/18). It is a separate stacked feature PR, not a replacement of the v0.3.0 management entrypoints or old generated bundles. Dependencies, Node engine floor and package version are unchanged.

KISS decisions: one catalog adapter, fixed local SVG artwork, existing projection/navigation services and role storage, one optional metadata-only RPC, no new configuration/UI framework or icon settings. Saved identities never depend on mutable management settings. Host state failure acknowledgement/rollback and close guards are retained. External role recording happens after successful activation without adding another startup flush or reporting an already-started activation as failed.

## Executed checks

- **48 suites / 1,489 tests passed**, Host/client/test TypeScript configurations, lint and reproducible checked-in bundles.
- Actual installed DSH **0.2.1-rc.2**, Linux, Node **22.23.4**:
  - `pnpm check:delegation`: actual headless launcher/Agent creation, five role routes and history/effort semantics, native read-only guard and repin, compaction, same-child warm and cold persistence after settings change.
  - `pnpm check:host`: **18** actual workflow checks, including native invalid-option behavior.
  - `pnpm check:management`: **20** real Loader/settings/ConfigEditor/ToolRuntime checks; existing management and role-write safety remain intact.
  - `pnpm check:probe`: actual authenticated client Connection → loopback HTTP → Gateway → source role-display Remote, plus the actual role-display client caller. Covers known/unknown/duplicate IDs, external activation identity, response allowlist, 100/101 batch boundaries, ID bounds, malformed named arguments, authentication/Origin 401/403, service disposal and missing-service unbadged fallback. Uses fixture saved-role data, not production storage.
- Independent read-only review verified installed slot kinds/scopes/IDs and found two UI regressions: absent visible current selection and missing title/mode/migration information in accessible names. Both were fixed and regression-tested. The selected row uses background plus bold text, preserving inherited theme colors rather than imposing a low-contrast dark-theme text color.

## Isolated Chromium component smoke

The optional [browser script](<../scripts/check-role-catalog-browser.mjs>) builds a self-contained `file://` fixture of the actual catalog components and styles, launches an explicitly selected Chromium with private HOME/user-data directory, drives real CDP keyboard/pointer input, captures screenshots and closes the browser before identity-checked cleanup. It installs no dependencies and does not connect to the running GUI or a real Host/model/CLI.

```sh
ROLE_CATALOG_BROWSER=/absolute/path/to/chrome \
  pnpm check:catalog-browser --out /absolute/new-evidence-directory
```

**Result: 14 checks passed** on Chrome 149.0.7827.55, including dark/light current-row emphasis. The final report has no fixture page/console errors, only its private `file://` document request, browser exit code 0 and confirmed private-HOME cleanup. Evidence: [report](<role-catalog-evidence/browser-report.json>), [desktop child lineage](<role-catalog-evidence/desktop.png>), [320px Japanese](<role-catalog-evidence/mobile-ja.png>), and [initial sandbox-unavailable failure](<role-catalog-evidence/browser-sandbox-unavailable.json>). Published JSON is formatted without changing values.

The browser's default Linux sandbox was unavailable on this host (user-namespace/AppArmor restriction). The initial failure was not counted as a pass. The successful local fixture run explicitly passed `--no-sandbox`; this weakens **Chromium's** OS isolation and is not a DSH sandbox change. It is limited to trusted, self-contained local fixture content with CSP, network interception and background networking disabled. Do not reuse this flag to browse untrusted content. Raw evidence retains the launch flags, runtime version and failed default attempt.

Checks include root/child/nested menus, recorded role SVGs, unknown and external rows, exact direct-parent navigation/aside behavior, keyboard opening/Escape/focus return, outside dismissal, title/mode/migration accessible labels, status/tokens/active duration, visible current selection, Japanese at a 320px viewport, hostile text rendering without HTML execution, reset/stale response cancellation, unavailable metadata with a real five-second retry, projection retry, pending request non-overlap, and no further polling after unmount. Two screenshots are evidence of the **fixture**, not of the running DSH Web GUI.

## Important remaining limits

- The browser fixture uses fixture projections/actions and inert slot injection to obtain CSS. Unit tests use a fake slot registry. **Real SlotRegistry winning-entry selection/restoration, live Cordis navigation-service disappearance/reappearance and full integrated DSH GUI navigation were not executed.** Installed public type/runtime contracts were inspected and match the registration adapter, but that is not equivalent to an integrated test.
- The custom catalog is a compact English/Japanese rendering; it does not promise upstream pixel, localization or formatting parity. Future owner-prop changes can require adaptation even if slot kind/scope remain the same.
- The per-request 100-ID/5-second bounds are not a global catalog-size/rate bound. Saved external metadata is best effort and is not a durability guarantee for a failed store.
- Native fixtures do not certify every DSH version, real inference/CLI behavior, OS sandbox enforcement or power-loss durability. Chromium errors/requests refer to the instrumented fixture page, not a universal browser/network security proof.
- No production profile, installed plugin/runtime, credentials or running DSH server was changed or restarted. No merge, release or deployment is implied by these results.
