import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { DurableEventMapper, type MapperScope } from '../src/mapper.ts'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const scope: MapperScope = { session: 'dsh-session-1', host: 'gogeta', cwd: '/Users/example/work', shellTools: ['bash'] }

function mapper(env?: Record<string, string>): DurableEventMapper {
  return new DurableEventMapper(scope, { now: () => NOW, ...env === undefined ? {} : { env } })
}

function userSaid(text: string, time = NOW): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(3),
    time,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

function assistantSaid(text: string, time = NOW, turn = 1): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(4),
    time,
    data: { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }), stream: [] },
  }
}

function bashCall(callId: string, command: string, time = NOW): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(5),
    time,
    data: { turn: 1, step: 1, callId: ToolCallId(callId), name: 'bash', arguments: JSON.stringify({ command }) },
  }
}

function resultOf(callId: string, isError = false, time = NOW, turn = 1): SessionEvent {
  return {
    type: 'tool/result',
    seq: SessionSeq(6),
    time,
    data: { turn, step: 1, message: { isError, toolCallId: ToolCallId(callId) } },
  }
}

describe('DurableEventMapper envelopes', () => {
  it('opens a run with title, host and working directory', () => {
    const row = mapper().sessionStart('Fix the parser')
    expect(row).toMatchObject({ ev: 'session_start', title: 'Fix the parser', host: 'gogeta', cwd: '/Users/example/work', who: 'system', turn: null })
    expect(row.ts).toBe(new Date(NOW).toISOString())
  })

  it('closes a run, beats running and idle, and numbers rows monotonically', () => {
    const subject = mapper()
    expect(subject.sessionEnd('done').ev).toBe('session_end')
    expect(subject.beat('running')).toMatchObject({ ev: 'beat', state: 'running', said: 'Working.' })
    expect(subject.beat('idle')).toMatchObject({ ev: 'beat', state: 'idle', said: 'Idle.' })
    expect(subject.beat('idle').id).toBe(4)
  })
})

describe('DurableEventMapper chat rows', () => {
  it('copies the text of a person message and nothing else', () => {
    const row = mapper().mapEvent(userSaid('continue please'))
    expect(row).toMatchObject({ who: 'you', said: 'continue please' })
    expect(row?.ev).toBeUndefined()
  })

  it('copies an assistant message and tracks its turn', () => {
    const row = mapper().mapEvent(assistantSaid('done', NOW, 2))
    expect(row).toMatchObject({ who: 'assistant', said: 'done', turn: 2 })
  })

  it('publishes nothing for a message with no text', () => {
    const event = {
      type: 'user/message',
      seq: SessionSeq(7),
      time: NOW,
      data: createUserMessage({ content: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }], source: { kind: 'user' } }),
    }
    expect(mapper().mapEvent(event)).toBeNull()
  })
})

describe('DurableEventMapper tool rows', () => {
  it('pairs a call with its result and reports duration', () => {
    const subject = mapper()
    expect(subject.mapEvent(bashCall('call-1', 'ls', NOW - 500))).toBeNull()
    const row = subject.mapEvent(resultOf('call-1', false, NOW))
    expect(row).toMatchObject({ ev: 'tool', name: 'bash', ok: true, ms: 500, refs: ['call-1'], said: 'bash finished.' })
  })

  it('reports a failed call', () => {
    const subject = mapper()
    subject.mapEvent(bashCall('call-2', 'false'))
    expect(subject.mapEvent(resultOf('call-2', true))).toMatchObject({ said: 'bash failed.', ok: false })
  })

  it('keeps a result whose call it never saw, without inventing a name or duration', () => {
    expect(mapper().mapEvent(resultOf('call-3'))).toMatchObject({ name: 'tool', ms: 0 })
  })

  it('publishes nothing for the call itself, so no arguments can leak', () => {
    expect(mapper().mapEvent(bashCall('call-4', 'echo SECRET-VALUE'))).toBeNull()
  })
})

describe('DurableEventMapper gate rows', () => {
  const asked = (callId?: string): SessionEvent => ({
    type: 'approval/asked',
    seq: SessionSeq(8),
    time: NOW,
    data: { id: 'gate-1', toolName: 'bash', ...callId === undefined ? {} : { callId: ToolCallId(callId) } },
  }) as SessionEvent

  const decided = (outcome: string): SessionEvent => ({
    type: 'approval/decided',
    seq: SessionSeq(9),
    time: NOW,
    data: { id: 'gate-1', outcome },
  }) as SessionEvent

  it('asks with the shell command the call carried', () => {
    const subject = mapper()
    subject.mapEvent(bashCall('call-5', 'rm -rf build'))
    expect(subject.mapEvent(asked('call-5'))).toMatchObject({
      ev: 'gate', tool: 'bash', cmd: 'rm -rf build', decision: null, beat: 'ask', who: 'gate',
    })
  })

  it('asks without a command for a tool that carries none', () => {
    const subject = mapper()
    expect(subject.mapEvent(asked())).toMatchObject({ cmd: '', said: 'Approve bash?' })
  })

  it('records an allowed-once decision', () => {
    const subject = mapper()
    subject.mapEvent(bashCall('call-6', 'make'))
    subject.mapEvent(asked('call-6'))
    expect(subject.mapEvent(decided('allowed-once'))).toMatchObject({ decision: 'allow-once', cmd: 'make', said: 'Allowed once.' })
  })

  it('records a rejection', () => {
    const subject = mapper()
    subject.mapEvent(asked())
    expect(subject.mapEvent(decided('rejected'))).toMatchObject({ decision: 'deny', said: 'Denied.' })
  })

  it.each(['cancelled', 'unavailable'])('publishes no row for a %s ask nobody answered', (outcome) => {
    const subject = mapper()
    subject.mapEvent(asked())
    expect(subject.mapEvent(decided(outcome))).toBeNull()
  })
})

describe('DurableEventMapper safety', () => {
  it('redacts a secret environment value inside the sentence', () => {
    const subject = mappper8()
    const row = subject.mapEvent(userSaid('deploy with super-secret-token-value'))
    expect(row?.said).toBe('deploy with [redacted]')
  })

  function mappper8(): DurableEventMapper {
    return mapper({ DSH_DEPLOY_TOKEN: 'super-secret-token-value' })
  }

  it('publishes nothing for an event without a phone-visible face', () => {
    const event = { type: 'turn/end', seq: SessionSeq(10), time: NOW, data: { turn: 1, reason: { kind: 'done' } } }
    expect(mapper().mapEvent(event)).toBeNull()
  })

  it('reports a turn start row', () => {
    const event = { type: 'turn/start', seq: SessionSeq(11), time: NOW, data: { turn: 3 } }
    expect(mapper().mapEvent(event)).toMatchObject({ ev: 'turn_start', turn: 3, said: 'Turn 3 started.' })
  })
})
