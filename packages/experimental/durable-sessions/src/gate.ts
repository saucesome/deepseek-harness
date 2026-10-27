/**
 * The approval command hash, and the check that ties one phone answer to the
 * exact command the person was shown.
 *
 * The durable store refuses an answer with no hash and requires every gate row to
 * carry one. The hash covers the command text as the card displayed it — after
 * redaction — so a person approves what they saw, not the raw text behind it, and
 * an answer for a different command cannot land on this gate.
 *
 * @module @deepseek-ai/dsh-experimental-durable-sessions/gate
 */

import { createHash } from 'node:crypto'
import type { AnswerRow, GateRow } from './wire.ts'

/**
 * Hash one command as it appears on the approval card.
 * @param command - the command text after redaction.
 * @returns the SHA-256 digest, lower-case hex.
 */
export function gateCommandHash(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

/**
 * Whether one answer belongs to one open gate.
 * @param answer - the decision read from the session log.
 * @param gate - the open gate row the answer claims.
 * @returns whether both the gate id and the command hash match.
 */
export function answerMatchesGate(answer: AnswerRow, gate: GateRow): boolean {
  return answer.gateId === String(gate.id) && answer.commandHash === gate.commandHash
}
