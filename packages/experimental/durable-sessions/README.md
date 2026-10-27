# @deepseek-ai/dsh-experimental-durable-sessions

The dsh host side of [eLicorice durable sessions](../../../docs/): what the run is allowed to tell a phone, and what the phone is allowed to tell the run.

This build carries the safety-critical half — the row vocabulary and its bounds, the redaction pass, and the allowlist mapper. The transport half (publish with heartbeat, one log tail, phone approvals, keep-awake) is not built yet; see [Not built yet](#not-built-yet).

## This copy is a holding place

The plugin's home is the eLicorice monorepo at `packages/dsh-harness-sessions`, published as `@elicorice/dsh-harness-sessions` and installed into one owner's profiles. It carries a private brand while dsh is public, so it does not join the dsh release family. This package is where the code was written and is reviewed; it moves when that package exists, and it is not the plugin's final home.

## What it owns

- **The row vocabulary** (`wire.ts`): the durable store's envelope fields, one `ev` variant per row kind, fixed per-field bounds, and validators for the two rows the phone may send (`input`, `answer`).
- **The allowlist mapper** (`mapper.ts`): derives rows from dsh's own durable session log. It names every field it copies, so a field added to a session event cannot reach the phone until someone names it here. Tool arguments, tool results, runtime context, images and reasoning are never copied; a tool row carries only name, outcome and duration.
- **The redaction pass** (`redact.ts`): replaces secret-shaped environment values and credential patterns in every sentence on the way out.

## Why the mapper reads the log, not live state

Rows come from the durable session log so a reconnecting phone can rebuild the same feed from the same events. Anything visible to the phone is therefore also present in dsh's own session file.

## Redaction is narrowed to named secrets

Every value of every environment variable would redact `PATH`, `HOME` and the rest of the environment and leave prompts unreadable. This package redacts values whose variable name marks them secret (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `COOKIE`, `SESSION`, `PRIVATE_KEY`, `API_KEY`) plus recognized credential formats, and documents that choice in `SECRET_ENV_NAME_RE` rather than hiding it in a pattern list.

## Not built yet

- Publishing rows and the 15-second heartbeat.
- The single inbound tail of the session's own log, and resuming it from the last cursor.
- The approval answerer on `approval/request`.
- Keep-awake for the live run.

All four need the eLicorice sign-in core to mint a token. That core lives in the private CandyCode repository and cannot be imported by this public one yet, so the transport half lands when it can be.

## Known wire-shape gaps

Two shapes in the design spec disagree with the durable store's published schema: the spec's `who: 'human' | 'agent'` against the schema's `you | assistant | system`, and the spec listing `ev` as an envelope field where the schema makes it a per-variant constant. This package follows the schema; both divergences are raised on the tracking ticket rather than guessed around.

## Testing

`pnpm exec vitest --run packages/experimental/durable-sessions` covers the vocabulary bounds, inbound validation, every mapper branch, and redaction. The mapper tests inject the clock and id source, so they assert exact rows.
