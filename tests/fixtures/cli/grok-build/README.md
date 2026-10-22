# Grok Build protocol fixture

`length.ndjson` records the answer/error events from Grok Build 1.0.62 (1474f9cbdd91), captured on 2026-10-22 by `DSH_CHECKOUT=/usr/lib/node_modules/@deepseek-ai/dsh CHECK_CLI_CASE='max token' pnpm check:cli grok-build` against the disposable localhost fake Chat Completions backend.

The fake returns `finish_reason: "length"`. The real binary emitted `error` with `max_tokens_truncation`, then exited 1 without `end`. This differs from the documented `end.stopReason: "max_tokens"` path, so both must be supported. The workspace path was replaced with `<workspace>` and the unrelated initial `available_commands` events omitted. No credentials or real model responses are in the fixture.
