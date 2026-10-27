/**
 * The redaction pass every published sentence goes through.
 *
 * Two sources are covered: secret-shaped environment values, and credential
 * patterns that appear inside ordinary text (a command line, a copied header, a
 * pasted token). Redaction runs on the way out, after the allowlist mapper has
 * chosen fields, so a value the mapper never copies is never at risk here.
 *
 * Environment redaction is narrowed to variables whose name marks them secret.
 * Wiping every environment value would redact `PATH` and leave prompts unreadable,
 * which trades a real leak for a useless feed; the exported
 * {@link SECRET_ENV_NAME_RE} documents the narrowing in one place.
 *
 * @module @deepseek-ai/dsh-experimental-durable-sessions/redact
 */

/** What a redacted stretch becomes. */
export const REDACTED = '[redacted]'

/**
 * Environment variable names whose values are treated as secrets. A name matches
 * when it contains a token, secret, password, credential, key, cookie or session
 * marker, in any case.
 */
export const SECRET_ENV_NAME_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|PRIVATE_KEY|API_?KEY|_KEY)/i

/** Credential values recognized inside ordinary text. */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /** OpenAI-style keys. */
  /sk-[A-Za-z0-9_-]{16,}/g,
  /** GitHub tokens. */
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /** Slack tokens. */
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /** AWS access key ids. */
  /AKIA[0-9A-Z]{16}/g,
  /** Anthropic-style keys. */
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /** A bearer credential in a copied header or command line. */
  /\bBearer\s+[\w.-]{16,}/gi,
  /** A JSON Web Token. */
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
]

/** Values shorter than this are not secrets and are left alone. */
const MIN_SECRET_CHARS = 8

/** Options for {@link redactSecrets}. */
export interface RedactOptions {
  /** Environment to read secret values from. Default: none, so tests stay hermetic. */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Replace every secret this pass recognizes with {@link REDACTED}.
 * @param text - one sentence the mapper selected.
 * @param options - the environment whose secret values must not escape.
 * @returns the sentence with secrets replaced; unchanged when nothing matched.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  let redacted = text
  const values = secretValues(options.env ?? {})
  // Longest first, so a secret that contains a shorter secret is replaced whole.
  for (const value of values) {
    redacted = redacted.split(value).join(REDACTED)
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED)
  }
  return redacted
}

/**
 * The distinct secret values present in an environment.
 * @param env - environment variables to filter.
 * @returns values worth redacting, longest first.
 */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_CHARS) continue
    if (!SECRET_ENV_NAME_RE.test(name)) continue
    values.add(value)
  }
  return [...values].sort((left, right) => right.length - left.length)
}
