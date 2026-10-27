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

All four need the eLicorice sign-in core to mint a token. That core is importable now — CandyCode's `./signin` graph reaches only `src/login/**`, `ajv`, `ajv-formats` and `undici` as of `d0d0a0b`, guarded by that repository's `test/signin-self-contained.test.ts` — but it is a private repository, so this public package cannot depend on it. The transport half is written in the out-of-tree package named above.

## Handoff notes for the out-of-tree package

- Pin `candycode` at `d0d0a0b` (it contains `eb78eb8`: the `./signin` and `./runs` exports and the required keychain names). The exported names did not change from `eb78eb8`.
- Pass keychain names as a hex digest of the normalized service URL, never free text. The macOS store builds an unquoted `security -i` stdin line from them, so free text can inject arguments; the digest also matches the store naming the design already requires.


## Backend contract the transport must respect

The hardened eLicorice backend (contract as of 2026-10-27; not deployed yet) fixes these, and the transport half must not drift from them. The bounds in `wire.ts` are these numbers.

- Sign in as the person. A machine or service token is refused on every dsh door with 403 `not_a_person`; the device sign-in comes from the keychain, never from a service secret.
- A `dsh` token exchange needs a verified second factor. The accepted methods come from the token service's configuration, and a missing list refuses everything rather than allowing a password; `dsh login` shows "sign in again with your second factor".
- Every gate row carries a non-empty `commandHash` and every answer must repeat it, or the store refuses the answer with 400. The hash covers the command as the card showed it, after redaction — see `gate.ts`.
- Bodies: phone-side messages, answers and session-create calls at most 64 KB; publish batches at most 50 rows and 256 KB; session titles at most 200 characters; device labels are length-capped.
- The envelope wins: a published payload cannot rewrite its own `turn` or `seq`. Publishing needs the `publish` scope plus the host's own session id.
- A gate answer is written first and the decision made in one step. An answer arriving after the 120-second `unavailable` timeout gets 409 `expired`, and the second of two answers gets 409. Both mean the gate is already closed; never retry them.
- A session reads as "not running" after 45 seconds without a heartbeat, so the 15-second heartbeat has three chances inside one window.

## Known wire-shape gaps

Two shapes in the design spec disagree with the durable store's published schema: the spec's `who: 'human' | 'agent'` against the schema's `you | assistant | system`, and the spec listing `ev` as an envelope field where the schema makes it a per-variant constant. This package follows the schema; both divergences are raised on the tracking ticket rather than guessed around.

## Testing

`pnpm exec vitest --run packages/experimental/durable-sessions` covers the vocabulary bounds, inbound validation, every mapper branch, and redaction. The mapper tests inject the clock and id source, so they assert exact rows.
