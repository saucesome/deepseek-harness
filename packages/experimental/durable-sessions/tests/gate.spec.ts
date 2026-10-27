import { describe, expect, it } from 'vitest'
import { answerMatchesGate, gateCommandHash } from '../src/gate.ts'
import type { AnswerRow, GateRow } from '../src/wire.ts'

const gate = (command: string, id = 7): GateRow => ({
  id,
  ts: '2026-10-27T00:00:00.000Z',
  session: 'dsh-1',
  turn: null,
  who: 'gate',
  said: `Approve: ${command}`,
  ev: 'gate',
  tool: 'bash',
  cmd: command,
  commandHash: gateCommandHash(command),
  decision: null,
})

const answer = (overrides: Partial<AnswerRow> = {}): AnswerRow => ({
  type: 'answer',
  seq: 9,
  requestId: 'abc12345-abcdef',
  gateId: '7',
  decision: 'allow-once',
  commandHash: gateCommandHash('make build'),
  ...overrides,
})

describe('gateCommandHash', () => {
  it('is a lower-case SHA-256 hex digest', () => {
    expect(gateCommandHash('make build')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable for the same text and different for different text', () => {
    expect(gateCommandHash('make build')).toBe(gateCommandHash('make build'))
    expect(gateCommandHash('make build')).not.toBe(gateCommandHash('make build '))
  })

  it('hashes the empty command to a non-empty digest, so the store always sees a hash', () => {
    expect(gateCommandHash('')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('answerMatchesGate', () => {
  it('accepts an answer for the same gate and command', () => {
    expect(answerMatchesGate(answer(), gate('make build'))).toBe(true)
  })

  it('refuses an answer whose gate id does not match', () => {
    expect(answerMatchesGate(answer({ gateId: '8' }), gate('make build'))).toBe(false)
  })

  it('refuses an answer for a different command', () => {
    expect(answerMatchesGate(answer(), gate('make release'))).toBe(false)
  })

  it('refuses an answer carrying an empty hash', () => {
    expect(answerMatchesGate(answer({ commandHash: '' }), gate('make build'))).toBe(false)
  })
})
