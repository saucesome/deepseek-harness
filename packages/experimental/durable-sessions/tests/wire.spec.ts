import { describe, expect, it } from 'vitest'
import {
  boundRow,
  MAX_CMD_CHARS,
  MAX_REFS,
  MAX_SAID_CHARS,
  MAX_TOOL_NAME_CHARS,
  parseInboundRow,
  type ToolRow,
} from '../src/wire.ts'

const base = {
  id: 1,
  ts: '2026-10-27T00:00:00.000Z',
  session: 'dsh-1',
  turn: null,
  who: 'assistant' as const,
  said: 'hello',
}

const requestId = 'abc12345-abcdef'

describe('boundRow', () => {
  it('truncates a long sentence with an ellipsis', () => {
    const row = boundRow({ ...base, said: 'x'.repeat(MAX_SAID_CHARS + 5) })
    expect(row.said.length).toBe(MAX_SAID_CHARS + 1)
    expect(row.said.endsWith('…')).toBe(true)
  })

  it('keeps the row variant and clamps its named fields', () => {
    const tool: ToolRow = boundRow({
      ...base,
      ev: 'tool',
      name: 'n'.repeat(MAX_TOOL_NAME_CHARS + 2),
      ok: true,
      ms: 12,
      refs: Array.from({ length: MAX_REFS + 3 }, (_value, index) => `ref-${index}`),
    })
    expect(tool.ev).toBe('tool')
    expect(tool.name.length).toBe(MAX_TOOL_NAME_CHARS + 1)
    expect(tool.refs).toHaveLength(MAX_REFS)
    expect(tool.ms).toBe(12)
  })

  it('clamps a gate command and a session title', () => {
    const gate = boundRow({ ...base, ev: 'gate', tool: 'bash', cmd: 'c'.repeat(MAX_CMD_CHARS + 1), decision: null })
    expect(gate.cmd.length).toBe(MAX_CMD_CHARS + 1)
    const start = boundRow({ ...base, ev: 'session_start', title: 't'.repeat(MAX_SAID_CHARS + 1), host: 'gogeta', cwd: '/tmp' })
    expect(start.title.length).toBe(MAX_SAID_CHARS + 1)
    expect(start.host).toBe('gogeta')
  })

  it('leaves a chat line without an ev tag', () => {
    const row = boundRow({ ...base, said: 'one sentence' })
    expect(row.ev).toBeUndefined()
    expect(row.said).toBe('one sentence')
  })
})

describe('parseInboundRow', () => {
  it('accepts a phone message', () => {
    expect(parseInboundRow({ type: 'input', seq: 4, requestId, text: 'continue', sender: 'phone' }))
      .toEqual({ type: 'input', seq: 4, requestId, text: 'continue', sender: 'phone' })
  })

  it('accepts an approval answer', () => {
    expect(parseInboundRow({ type: 'answer', seq: 5, requestId, gateId: 'gate-1', decision: 'allow-once', commandHash: 'h' }))
      .toEqual({ type: 'answer', seq: 5, requestId, gateId: 'gate-1', decision: 'allow-once', commandHash: 'h' })
  })

  it.each([
    ['a non-object', null],
    ['an unknown type', { type: 'other', seq: 1, requestId }],
    ['a missing seq', { type: 'input', requestId, text: 'hi' }],
    ['a malformed request id', { type: 'input', seq: 1, requestId: 'bad', text: 'hi' }],
    ['empty text', { type: 'input', seq: 1, requestId, text: '' }],
    ['a decision outside the vocabulary', { type: 'answer', seq: 1, requestId, gateId: 'g', commandHash: 'h', decision: 'maybe' }],
    ['an answer without a hash', { type: 'answer', seq: 1, requestId, gateId: 'g', decision: 'deny' }],
    ['an answer without a gate', { type: 'answer', seq: 1, requestId, commandHash: 'h', decision: 'deny' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseInboundRow(raw)).toBeNull()
  })

  it('rejects text above the input limit', () => {
    expect(parseInboundRow({ type: 'input', seq: 1, requestId, text: 'x'.repeat(100_001) })).toBeNull()
  })
})
