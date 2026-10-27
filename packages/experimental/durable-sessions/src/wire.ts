/**
 * The durable session store's row vocabulary, and the bounds every published row
 * carries.
 *
 * Published rows follow CandyCode's event envelope (`docs/events.schema.json`,
 * `$defs/envelope`): plain chat lines are envelope-only, and every other row adds
 * an `ev` discriminator. This package owns only the fields it names; a field the
 * mapper does not copy never reaches the wire.
 *
 * Inbound rows are the phone's write path: `input` rows carry a message and
 * `answer` rows carry one approval decision. Both arrive on the session's own log
 * tail, validated here before anything acts on them.
 *
 * @module @deepseek-ai/dsh-experimental-durable-sessions/wire
 */

/** Longest chat sentence retained in one row. */
export const MAX_SAID_CHARS = 4000
/** Longest command retained in a gate row. */
export const MAX_CMD_CHARS = 2000
/** Longest tool name retained in a row. */
export const MAX_TOOL_NAME_CHARS = 64
/** Most reference ids retained in one row. */
export const MAX_REFS = 16
/** Longest phone message accepted from the tail. */
export const MAX_INPUT_CHARS = 100_000
/** A request id the store accepts: 8 to 80 of these characters. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{8,80}$/

/**
 * Who a row is attributed to. These are the shared envelope's `who` values from
 * `docs/events.schema.json`; the host session is never a participant, so `party`
 * and `companion` are absent.
 */
export type RowWho = 'you' | 'assistant' | 'system' | 'gate'

/** Heartbeat slot the publisher fills to tell the store what the run is doing. */
export type RowBeat = 'ask' | 'attempt' | 'detour' | 'decision' | 'delivery' | 'next_ask'

/** Fields every published row carries. */
export interface EnvelopeFields {
  /** Monotonic within a session. */
  id: number
  /** When the row was produced, ISO-8601. */
  ts: string
  /** The durable session this row belongs to. */
  session: string
  /** Turn the row belongs to; `null` outside a turn. */
  turn: number | null
  who: RowWho
  /** Plain-English sentence the phone renders. */
  said: string
  /** Ids the row refers to, such as a tool call. */
  refs?: string[]
  beat?: RowBeat
}

/** One chat line: envelope only, no `ev`. */
export interface SaidRow extends EnvelopeFields {
  ev?: undefined
}

/** The run opened. */
export interface SessionStartRow extends EnvelopeFields {
  ev: 'session_start'
  /** Human-facing session title. */
  title: string
  /** Host label the run belongs to. */
  host: string
  /** Working directory the run started in. */
  cwd: string
}

/** A turn opened. */
export interface TurnStartRow extends EnvelopeFields {
  ev: 'turn_start'
}

/** One completed tool call: name, outcome and duration, never its arguments or result. */
export interface ToolRow extends EnvelopeFields {
  ev: 'tool'
  name: string
  ok: boolean
  /** Wall time of the call, in milliseconds. */
  ms: number
}

/** A question waiting for, or carrying, a human decision. */
export interface GateRow extends EnvelopeFields {
  ev: 'gate'
  tool: string
  cmd: string
  /** `null` while the question is open. */
  decision: 'allow-once' | 'deny' | null
}

/** The run's liveness, sent on every publish call. */
export interface BeatRow extends EnvelopeFields {
  ev: 'beat'
  state: 'running' | 'idle'
}

/** The run ended. */
export interface SessionEndRow extends EnvelopeFields {
  ev: 'session_end'
  reason: string
}

/** Every row this package publishes. */
export type PublishedRow =
  | SaidRow
  | SessionStartRow
  | TurnStartRow
  | ToolRow
  | GateRow
  | BeatRow
  | SessionEndRow

/** One phone message read from the session log. */
export interface InputRow {
  type: 'input'
  /** Position in the session log; the reader resumes after it. */
  seq: number
  /** The phone's idempotency id for this message. */
  requestId: string
  text: string
  /** The device row the store stamped; absent when the store did not stamp one. */
  sender?: string
}

/** One approval decision read from the session log. */
export interface AnswerRow {
  type: 'answer'
  seq: number
  requestId: string
  /** The gate row this answers. */
  gateId: string
  decision: 'allow-once' | 'deny'
  /** Hash the asker published with the question, so a stale answer cannot land. */
  commandHash: string
  sender?: string
}

/** Every inbound row this package acts on. */
export type InboundRow = InputRow | AnswerRow

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`

/**
 * Clamp one row to the bounds above. Truncation is by code unit and keeps a
 * trailing ellipsis so a reader can tell that the sentence was cut.
 * @param row - the complete row the mapper produced.
 * @returns the same row variant with every unbounded string clamped.
 */
export function boundRow<T extends PublishedRow>(row: T): T {
  const bounded: PublishedRow = {
    ...row,
    said: truncate(row.said, MAX_SAID_CHARS),
    ...(row.refs === undefined ? {} : { refs: row.refs.slice(0, MAX_REFS) }),
  }
  switch (bounded.ev) {
    case 'tool':
      bounded.name = truncate(bounded.name, MAX_TOOL_NAME_CHARS)
      break
    case 'gate':
      bounded.tool = truncate(bounded.tool, MAX_TOOL_NAME_CHARS)
      bounded.cmd = truncate(bounded.cmd, MAX_CMD_CHARS)
      break
    case 'session_start':
      bounded.title = truncate(bounded.title, MAX_SAID_CHARS)
      bounded.host = truncate(bounded.host, MAX_TOOL_NAME_CHARS)
      bounded.cwd = truncate(bounded.cwd, MAX_CMD_CHARS)
      break
    case 'session_end':
      bounded.reason = truncate(bounded.reason, MAX_TOOL_NAME_CHARS)
      break
    case 'turn_start':
    case 'beat':
    case undefined:
      break
  }
  // Each branch rewrites only fields of the same variant, so the row keeps its
  // variant; the compiler cannot follow mutation-based narrowing through it.
  return bounded as T
}

/**
 * Validate one row read from the session log tail. Unknown row types, a missing
 * idempotency id, and oversized text all resolve `null`: a row the reader cannot
 * trust must never move the cursor.
 * @param raw - one parsed JSON value from the tail.
 * @returns the row, or `null` when it is not one this package acts on.
 */
export function parseInboundRow(raw: unknown): InboundRow | null {
  if (!isObject(raw)) return null
  if (!isSeq(raw.seq) || typeof raw.requestId !== 'string' || !REQUEST_ID_RE.test(raw.requestId)) return null
  const sender = typeof raw.sender === 'string' && raw.sender.length > 0 ? raw.sender : undefined
  switch (raw.type) {
    case 'input': {
      if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > MAX_INPUT_CHARS) return null
      return { type: 'input', seq: raw.seq, requestId: raw.requestId, text: raw.text, ...sender === undefined ? {} : { sender } }
    }
    case 'answer': {
      if (typeof raw.gateId !== 'string' || raw.gateId.length === 0) return null
      if (typeof raw.commandHash !== 'string' || raw.commandHash.length === 0) return null
      if (raw.decision !== 'allow-once' && raw.decision !== 'deny') return null
      return {
        type: 'answer',
        seq: raw.seq,
        requestId: raw.requestId,
        gateId: raw.gateId.slice(0, 200),
        decision: raw.decision,
        commandHash: raw.commandHash.slice(0, 200),
        ...sender === undefined ? {} : { sender },
      }
    }
    default:
      return null
  }
}
