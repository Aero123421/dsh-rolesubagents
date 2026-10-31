# Grok official sandbox integration review

> **Historical scope:** the investigation/review below concerns Grok's **native official sandbox profiles**, not the new default Grok/Pi `workspace-write` path. Its findings remain valid: Bubblewrap was unavailable on the tested host and managed `off` could override a requested native profile. The new path independently wraps the exact CLI/private bootstrap with DSH's existing `ctx.sandbox.confine`; it does not rely on Grok native `--sandbox` flags or introduce a VM/custom sandbox. Explicit `native` remains full-access-only and unchanged; read-only is unsupported. This is the same path-based file policy as parent Bash (CWD + `/tmp` writable, global reads/network/process visibility unrestricted), **not hardlink-safe or absolute outside-effect isolation**: existing inode aliases can share writes outside the root. Partial enforcement (tested Linux Landlock ABI 4, without device ioctl handling) is additionally warned. Native historical evidence does not qualify the new host-confined preset. See the [current design](external-cli.md#host-confined-grokpi) and [host-confined validation](host-confined-cli-validation.md) for current behavior and scoped evidence. The remainder is preserved as a historical record.


Review follow-up for PR #14, 2026-10-23. Grok Build and Pi must not be described as lacking the same capabilities: Grok has official OS sandbox profiles; Pi has no comparable built-in boundary for arbitrary native extension code. The existing unrestricted/native presets still require an explicitly full-access parent. That condition does not force Grok's configured sandbox off or enable always-approve.

## Source scope

This is analysis of public Grok source fixed at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` and official documentation, **not proof that it is the source of installed Grok 1.0.62 / build 1474f9cbdd91**. Real binary experiments are recorded separately in the sandbox investigation report.

### Official profiles are real, with qualified guarantees

The [official sandbox documentation](https://docs.x.ai/build/features/sandbox.md) describes `workspace` (writes CWD, Grok home and temporary locations) and `read-only` (writes Grok home and temporary locations). `strict` permits CWD writes and is not a read-only substitute. Linux child-network restrictions do not cover all in-process model/web/remote MCP requests; macOS does not apply that child-network restriction.

The [fixed path-grant implementation](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/paths.rs) includes `/tmp`, `/var/tmp` and `TMPDIR`. Consequently, using a test project or outside-write target under either standard temporary directory cannot establish the intended ordinary-project filesystem boundary. Read-only also cannot mean an immutable project when the project itself lies under an allowed temporary/Grok path.

### Lower-level warnings do not imply a universal fail-open CLI

The [CLI startup caller](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/config/mod.rs#L1356-L1515) refuses required Bubblewrap preparation/execution/verification failures on Linux and checks applied protection for relevant profiles on Linux/macOS. Reading only `SandboxManager::apply` warning behavior would miss these checks. Unknown profile strings are treated as custom profiles; an undefined custom profile is not demonstrated to silently become `off`.

### A requested flag is not an effective-profile attestation

[Profile resolution](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/config.rs#L618-L650) gives deployment requirements higher precedence than the CLI: requirements > CLI > environment > ordinary configuration > off. A valid managed pin such as `off` or `devbox` can therefore defeat the intended restriction even when `--sandbox read-only` was passed. The plugin must not rewrite the administrator's policy.

The [inspect report implementation](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/inspect/mod.rs) does not expose an effective/applied sandbox attestation at this source revision. A separate preflight is not equivalent to asserting the actual run's profile: [startup](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs#L2148-L2210) performs managed-policy healing before sandbox application. An after-start log message also cannot retroactively prevent already-executed startup side effects.

A robust thin integration needs an upstream mechanism to assert the requested effective profile and refuse conflicts before agent/hook/MCP work, or equivalent verified conditions. It must not treat a CLI argument, successful version probe or separate inspect process as such a guarantee.

### Approval policy and remote side effects are separate

The [permission manager](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/permission/manager/mod.rs) can honor inherited allow rules and remembered MCP grants before the final `dontAsk` denial policy. Thus `--permission-mode dontAsk` is not a closed allowlist. Native explicit deny rules take precedence; a hypothetical read-only implementation must test remote mutating MCP calls with inherited grants rather than assuming they are blocked.

[HTTP lifecycle hooks](https://docs.x.ai/build/features/hooks.md) and [remote MCP servers](https://docs.x.ai/build/features/mcp-servers.md) can mutate remote data independently of local filesystem protection. A filesystem sandbox cannot be relabeled a universal no-side-effect boundary while arbitrary native configuration/hooks are preserved. Do not silently disable every extension, introduce a custom VM/sandbox, or escalate parent permissions to conceal this distinction.

## Acceptance before offering restricted presets

1. Use the exact version/SHA256 and OS under test; do not generalize to other platforms or the public source revision.
2. In one healthy read-only execution, show successful ordinary-project reads followed by denied writes, not only absent files after failed startup.
3. In a healthy workspace execution, show successful inside edits and denied ordinary outside writes; keep projects/targets outside Grok/temp exceptions.
4. Verify hooks, local MCP and a normal venv without plugin-wide recursive rejection, and state the actual local/remote guarantee.
5. Exercise sandbox unavailable, management-profile conflicts, unsupported versions/platforms and noninteractive approval behavior. No fallback to unrestricted native execution.
6. Retain completion, cancellation, timeout, process cleanup and precise evidence scopes. The existing native evidence does not certify these sandbox profiles.

If these conditions cannot be established, retain the refusal and document why; adding a claimed restrictive preset anyway would violate the PR's access-ceiling contract.

## Concrete thin-adapter choices

Keep `native` unchanged. Candidate additional presets would map the internal names `read-only` / `workspace-write` to the literal official CLI values `--sandbox read-only` / `--sandbox workspace`, reusing the current task-file, streaming-json, process engine, cancellation and timeout paths. Do not use `strict` as a read-only substitute or change an unsupported restrictive run into native execution.

[Current headless documentation](https://docs.x.ai/build/enterprise.md#permissions) describes `dontAsk` as silently refusing operations requiring new approval, while `acceptEdits` auto-approves edits but can still prompt for shell commands. These approval modes are separate from kernel confinement. The [fixed permission guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md) documents explicit rules, existing grants and native read-only conveniences. Test inherited allow/ask/yolo and sandbox Bash-auto-approval settings, rather than certifying behavior from an empty temporary profile alone.

For a restricted preset, native `--deny 'MCPTool(*)'` is a candidate to prohibit model-driven MCP invocation despite inherited allows while **retaining** server configuration/discovery. It requires a dummy remote-server test with a mutating tool and an inherited allow/grant. It does not make arbitrary retained HTTP lifecycle hooks non-mutating, and is not a recommendation to unload every extension. If the parent requires a stronger no-remote-side-effect contract that native mechanisms cannot establish, refuse that unsupported combination.

### Recommended upstream startup contract

Prefer a small official capability over reimplementing Grok configuration policy in the plugin:

- A session-scoped assertion of the required effective profile or maximum access.
- Resolve current requirements, including startup policy healing, then reject any conflicting/weaker profile **before agent/hooks/MCP/tool dispatch**. Do not modify the policy.
- Require successful kernel enforcement on supported targets; reject unsupported OS/builds rather than falling back.
- Emit a structured, versioned record of the effective profile, applied state, platform/backend and writable exceptions before accepting the task.

A separate inspect call or requested-profile string is insufficient because it does not bind the actual task launch. Parsing a post-start log does not retroactively constrain side effects. The [managed-policy supervisor](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-cloud-config/src/managed_config/supervisor.rs) can apply staged policy, refresh authentication and fetch configuration before sandbox application; this is why an assertion should be part of the actual startup transaction.

## Testing missing Bubblewrap without changing the host

Resolve the real Grok executable to an absolute path and use disposable HOME/config, an ordinary test-owned workspace outside native writable exceptions, and a localhost fake model with a dummy key. For that child process only, a test-owned PATH omitting `bwrap` can exercise an executable-not-found failure; provide any necessary shell/test utilities explicitly. A separate test-owned `bwrap` shim that exits nonzero exercises launch failure, **not kernel enforcement**.

Assert a nonzero configuration/startup failure, no valid protocol completion, no inference request, and no prohibited test-owned project/MCP/hook effect. Missing output files after failed startup do not establish successful read-only execution. Do not uninstall/rename the host executable, change sysctls or kernel permissions, spoof an internal marker to bypass checks, or use real provider credentials. Test weaker requirements only in disposable user configuration; an authoritative system pin is a condition to report, not to override.

## Additional provenance limitation

The public tree's [SOURCE_REV](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/SOURCE_REV) contains `559751fdcec02d413e4c57c8832ab275e4f44980`, and its [pager package manifest](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/Cargo.toml) has package version `1.0.45`. Neither value identifies the installed 1.0.62 binary. Preserve source analysis, actual binary version/build/SHA256, startup refusals, synthetic launch faults and successful same-session enforcement as distinct evidence classes; do not infer a compatible minimum version from these source files.
