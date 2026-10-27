/**
 * The dsh host side of eLicorice durable sessions.
 *
 * This build carries the part of the host side that decides what leaves the
 * machine and what the phone may send back: the row vocabulary with its bounds,
 * the redaction pass, and the allowlist mapper that derives rows from the durable
 * session log. The transport half — publishing rows, tailing the session log,
 * answering approval questions, and keeping the machine awake — is not here yet;
 * it lands once the sign-in core it needs can be imported.
 *
 * @module @deepseek-ai/dsh-experimental-durable-sessions
 */

export {
  boundRow,
  MAX_CMD_CHARS,
  MAX_INPUT_CHARS,
  MAX_REFS,
  MAX_SAID_CHARS,
  MAX_TOOL_NAME_CHARS,
  parseInboundRow,
  REQUEST_ID_RE,
  type AnswerRow,
  type BeatRow,
  type EnvelopeFields,
  type GateRow,
  type InboundRow,
  type InputRow,
  type PublishedRow,
  type RowBeat,
  type RowWho,
  type SaidRow,
  type SessionEndRow,
  type SessionStartRow,
  type ToolRow,
  type TurnStartRow,
} from './wire.ts'
export { REDACTED, redactSecrets, SECRET_ENV_NAME_RE, SECRET_VALUE_PATTERNS, secretValues, type RedactOptions } from './redact.ts'
export { DurableEventMapper, type MapperOptions, type MapperScope } from './mapper.ts'
