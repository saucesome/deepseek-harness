import { describe, expect, it } from 'vitest'
import { redactSecrets, REDACTED, secretValues, SECRET_ENV_NAME_RE } from '../src/redact.ts'

describe('redactSecrets', () => {
  it('replaces an environment value whose name marks it secret', () => {
    const env = { DSH_GITHUB_TOKEN: 'gh-value-that-must-not-leave', PATH: '/usr/local/bin:/usr/bin' }
    expect(redactSecrets('deploy with gh-value-that-must-not-leave now', { env }))
      .toBe(`deploy with ${REDACTED} now`)
  })

  it('leaves a non-secret environment value readable', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/example' }
    expect(redactSecrets('look under /usr/local/bin first', { env })).toBe('look under /usr/local/bin first')
  })

  it('redacts the longer secret before a shorter one it contains', () => {
    const env = { API_SECRET_LONG: 'abcdefgh-longer', API_SECRET_SHORT: 'abcdefgh' }
    expect(redactSecrets('abcdefgh-longer', { env })).toBe(REDACTED)
  })

  it.each([
    ['sk-', 'sk-abcdefghijklmnopqrstuvwx'],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github pat', 'github_pat_abcdefghijklmnopqrstuvwxyz'],
    ['slack', 'xoxb-1234567890-abcdefghij'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['anthropic', 'sk-ant-abcdefghijklmnopqrstuvwx'],
    ['bearer', 'Bearer abcdefghijklmnopqrstuvwxyz'],
    ['jwt', 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'],
  ])('redacts a %s credential in ordinary text', (_label, secret) => {
    const redacted = redactSecrets(`token=${secret} done`)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain(REDACTED)
  })

  it('returns ordinary prose unchanged', () => {
    expect(redactSecrets('Refactor the parser and rerun the tests.')).toBe('Refactor the parser and rerun the tests.')
  })

  it('ignores environment values shorter than a real secret', () => {
    expect(redactSecrets('value is abc', { env: { SOME_TOKEN: 'abc' } })).toBe('value is abc')
  })
})

describe('secretValues', () => {
  it('keeps only named secret variables, longest first', () => {
    const values = secretValues({ A_TOKEN: 'aaaaaaaa', B_API_KEY: 'bbbbbbbbbbbb', PATH: '/usr/bin' })
    expect(values).toEqual(['bbbbbbbbbbbb', 'aaaaaaaa'])
  })

  it('deduplicates a value shared by two variables', () => {
    expect(secretValues({ FIRST_TOKEN: 'shared-secret', SECOND_TOKEN: 'shared-secret' })).toEqual(['shared-secret'])
  })

  it('ignores undefined and short values', () => {
    expect(secretValues({ EMPTY_TOKEN: undefined, SHORT_KEY: 'abc' })).toEqual([])
  })
})

describe('SECRET_ENV_NAME_RE', () => {
  it.each(['GITHUB_TOKEN', 'DSH_API_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'SESSION_COOKIE', 'PRIVATE_KEY'])(
    'matches %s',
    (name) => {
      expect(SECRET_ENV_NAME_RE.test(name)).toBe(true)
    },
  )

  it.each(['PATH', 'HOME', 'NODE_ENV', 'TERM'])('does not match %s', (name) => {
    expect(SECRET_ENV_NAME_RE.test(name)).toBe(false)
  })
})
