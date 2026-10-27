/**
 * The outbound allowlist mapper: the only place that decides what leaves the
 * machine.
 *
 * It names the fields it copies — sentence text, tool name, outcome, duration and
 * the approval question — and copies nothing else. A field added to a dsh session
 * event is invisible to the phone until it is named here on purpose, which is why
 * this is an allowlist and not a blocklist. Tool arguments, tool results, runtime
 * context, images and reasoning are never named.
 *
 * Rows are derived from the durable session log, never from live-only state, so a
 * reconnect replays the same rows from the same events.
 *
 * @module @deepseek-ai/dsh-experimental-durable-sessions/mapper
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { redactSecrets, type RedactOptions } from './redact.ts'
import {
  boundRow,
  type BeatRow,
  type EnvelopeFields,
  type PublishedRow,
  type RowBeat,
  type RowWho,
  type SessionEndRow,
  type SessionStartRow,
  type ToolRow,
} from './wire.ts'

/** Facts about the run that every row repeats. */
export interface MapperScope {
  /** The durable session id this run publishes under. */
  session: string
  /** Host label the run belongs to, such as the machine name. */
  host: string
  /** Working directory the run started in. */
  cwd: string
  /**
   * Tool names whose arguments carry a shell command. Only these contribute the
   * gate row's `cmd`; every other tool keeps its command unread.
   */
  shellTools: readonly string[]
}

/** Injected nondeterminism, so the mapper is testable without a clock. */
export interface MapperOptions {
  /** Wall clock in epoch milliseconds. Default: {@link Date.now}. */
  now?: () => number
  /** Monotonic row id source, starting at 1. Default: an internal counter. */
  nextId?: () => number
  /** Environment whose secret values are redacted. */
  env?: Readonly<Record<string, string | undefined>>
}

/** One remembered tool call, kept only to pair its result and price its gate. */
interface PendingCall {
  readonly name: string
  readonly shellCommand: string | undefined
  readonly startedAt: number
}

/** Everything a live approval question needs to survive until its decision arrives. */
interface PendingGate {
  readonly tool: string
  readonly cmd: string
}

/**
 * Read the model-facing text of one message and drop everything else. Images,
 * tool attachments and reasoning never contribute a sentence.
 * @param content - the message's content blocks.
 * @returns the joined text blocks, or the empty string when there is no text.
 */
function textOf(content: readonly { readonly type: string }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Read one shell command out of a tool call's raw arguments.
 * @param name - the tool name the model called.
 * @param rawArguments - the raw JSON string exactly as the model produced it.
 * @param shellTools - tool names allowed to contribute a command.
 * @returns the command, or `undefined` when this tool is not a shell tool.
 */
function shellCommandOf(name: string, rawArguments: string, shellTools: readonly string[]): string | undefined {
  if (!shellTools.includes(name)) return undefined
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (typeof parsed === 'object' && parsed !== null && 'command' in parsed) {
      const command = parsed.command
      if (typeof command === 'string') return command
    }
  } catch {
    // Malformed arguments belong to the model; a gate row without a command still asks the question.
  }
  return undefined
}

/**
 * The sentence one gate asks.
 * @param tool - the tool the question is about.
 * @param cmd - the shell command, when the tool is a shell tool.
 * @returns the sentence the phone renders.
 */
function gateSentence(tool: string, cmd: string): string {
  return cmd === '' ? `Approve ${tool}?` : `Approve: ${cmd}`
}

/**
 * Turns session log events into durable-store rows.
 *
 * One instance follows one run: it carries the row id counter, the current turn,
 * and the tool calls still waiting for a result. It is not shared between runs.
 */
export class DurableEventMapper {
  /** Fields repeated on every row. */
  readonly scope: MapperScope
  readonly #now: () => number
  readonly #nextId: () => number
  readonly #redact: RedactOptions
  readonly #calls = new Map<string, PendingCall>()
  readonly #gates = new Map<string, PendingGate>()
  #turn: number | null = null
  #lastId = 0

  /**
   * @param scope - run facts repeated on every row.
   * @param options - injected clock, id source and redaction environment.
   */
  constructor(scope: MapperScope, options: MapperOptions = {}) {
    this.scope = scope
    this.#now = options.now ?? Date.now
    this.#nextId = options.nextId ?? (() => ++this.#lastId)
    this.#redact = options.env === undefined ? {} : { env: options.env }
  }

  /**
   * The row that opens the run on the phone.
   * @param title - human-facing title, chosen by the publisher.
   * @returns the bounded `session_start` row.
   */
  sessionStart(title: string): SessionStartRow {
    return boundRow({
      ...this.#envelope({ who: 'system', said: `Started: ${title}` }),
      ev: 'session_start',
      title: redactSecrets(title, this.#redact),
      host: this.scope.host,
      cwd: this.scope.cwd,
    })
  }

  /**
   * The row that closes the run.
   * @param reason - why the run ended, as the publisher reported it.
   * @returns the bounded `session_end` row.
   */
  sessionEnd(reason: string): SessionEndRow {
    return boundRow({
      ...this.#envelope({ who: 'system', said: `Ended: ${reason}` }),
      ev: 'session_end',
      reason,
    })
  }

  /**
   * The liveness row; the publisher appends one to every publish call so the list
   * can mark a silent run as not running.
   * @param state - whether the run is currently working.
   * @returns the bounded `beat` row.
   */
  beat(state: BeatRow['state']): BeatRow {
    return boundRow({
      ...this.#envelope({ who: 'system', said: state === 'running' ? 'Working.' : 'Idle.' }),
      ev: 'beat',
      state,
    })
  }

  /**
   * Map one durable session event to the row it publishes, if any.
   * @param event - one event from the session log.
   * @returns the row to publish, or `null` when the event has no phone-visible face.
   */
  mapEvent(event: SessionEvent): PublishedRow | null {
    switch (event.type) {
      case 'turn/start':
        this.#turn = event.data.turn
        return boundRow({
          ...this.#envelope({ who: 'system', said: `Turn ${event.data.turn} started.`, at: event.time }),
          ev: 'turn_start',
        })
      case 'user/message': {
        const text = textOf(event.data.content)
        if (text === '') return null
        return boundRow(this.#envelope({ who: 'you', said: text, at: event.time }))
      }
      case 'assistant/message': {
        this.#turn = event.data.turn
        const text = textOf(event.data.message.content)
        if (text === '') return null
        return boundRow(this.#envelope({ who: 'assistant', said: text, at: event.time }))
      }
      case 'tool/call':
        this.#calls.set(String(event.data.callId), {
          name: event.data.name,
          shellCommand: shellCommandOf(event.data.name, event.data.arguments, this.scope.shellTools),
          startedAt: event.time,
        })
        return null
      case 'tool/result': {
        this.#turn = event.data.turn
        const callId = String(event.data.message.toolCallId)
        const call = this.#calls.get(callId)
        this.#calls.delete(callId)
        // A result whose call this process never saw (a resumed log) keeps its id
        // and reports no name rather than inventing one.
        const name = call?.name ?? 'tool'
        const row: ToolRow = {
          ...this.#envelope({
            who: 'assistant',
            said: event.data.message.isError ? `${name} failed.` : `${name} finished.`,
            at: event.time,
            refs: [callId],
          }),
          ev: 'tool',
          name,
          ok: !event.data.message.isError,
          ms: call === undefined ? 0 : Math.max(0, event.time - call.startedAt),
        }
        return boundRow(row)
      }
      case 'approval/asked': {
        const callId = event.data.callId
        const pending = callId === undefined ? undefined : this.#calls.get(String(callId))
        const gate: PendingGate = { tool: event.data.toolName, cmd: pending?.shellCommand ?? '' }
        this.#gates.set(String(event.data.id), gate)
        return boundRow({
          ...this.#envelope({ who: 'gate', said: gateSentence(gate.tool, gate.cmd), at: event.time, beat: 'ask' }),
          ev: 'gate',
          tool: gate.tool,
          cmd: gate.cmd,
          decision: null,
        })
      }
      case 'approval/decided': {
        const gate = this.#gates.get(String(event.data.id))
        this.#gates.delete(String(event.data.id))
        // Only an explicit decision is a row the phone can show. A cancelled or
        // unavailable ask never reached a person, so it publishes no decision row.
        if (event.data.outcome !== 'allowed-once' && event.data.outcome !== 'rejected') return null
        const decision = event.data.outcome === 'allowed-once' ? 'allow-once' : 'deny'
        return boundRow({
          ...this.#envelope({
            who: 'gate',
            said: decision === 'allow-once' ? 'Allowed once.' : 'Denied.',
            at: event.time,
            beat: 'decision',
          }),
          ev: 'gate',
          tool: gate?.tool ?? 'unknown',
          cmd: gate?.cmd ?? '',
          decision,
        })
      }
      default:
        // Merge-extensible event map: an event this build does not know publishes nothing.
        return null
    }
  }

  /**
   * Build the envelope half of a row, redacting the sentence on the way out.
   * @param row - the fields this event contributes.
   * @param row.who - who the row is attributed to.
   * @param row.said - the sentence, before redaction.
   * @param row.at - event time in epoch milliseconds; omitted reads the wall clock.
   * @param row.refs - ids the row refers to.
   * @param row.beat - heartbeat slot this row fills.
   * @returns the envelope fields, ready to spread onto a typed row.
   */
  #envelope(row: { who: RowWho; said: string; at?: number; refs?: string[]; beat?: RowBeat }): EnvelopeFields {
    return {
      id: this.#nextId(),
      ts: new Date(row.at ?? this.#now()).toISOString(),
      session: this.scope.session,
      turn: this.#turn,
      who: row.who,
      said: redactSecrets(row.said, this.#redact),
      ...row.refs === undefined ? {} : { refs: row.refs },
      ...row.beat === undefined ? {} : { beat: row.beat },
    }
  }
}
