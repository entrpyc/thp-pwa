/**
 * **One definition of "this environment reaches no external provider."**
 *
 * Three adapters already had their own way of being switched off — `ASR_PROVIDER=fake`,
 * `GENERATE_PROVIDER=fake`, `MAIL_TRANSPORT=capture` — each correct on its own and each a separate
 * thing to remember. `THP_MOCK_EXTERNAL=true` sets all three at once, and that is the whole of it:
 * no fourth transport, no new adapter, no per-provider override.
 *
 * **It is not a convenience.** Development runs against the MinIO container, and the worker hands
 * the ASR provider a signed URL to *fetch the object itself* rather than sending it bytes
 * (docs/epics/epic-core-listening/implementation-plan.md, the *provider is handed a location*
 * decision). A bucket on `127.0.0.1` is not reachable from Deepgram, so a MinIO development
 * environment **cannot** use real transcription at all. This switch is the honest statement of
 * that rather than a shortcut around it.
 *
 * **The mock wins over an explicitly named real provider**, deliberately. The switch's promise is
 * that nothing leaves the machine, and a promise with exceptions in it cannot be relied on — a
 * developer who sets it should not have to audit three other variables to know whether they are
 * about to spend money.
 *
 * A deployment never sets it, and `scripts/verify-production.mjs` asserts that on the box.
 *
 * **Why this module takes its environment as an argument and never reads `process.env`:**
 * `@thp/shared` is importable by the client (tools/import-boundary.ts does not list it as
 * server-only), and a client bundle should not carry a read of the process environment. Every
 * caller already has an `EnvSource` in hand.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Named once so a reader grepping for the switch finds the definition rather than a use. */
export const MOCK_EXTERNAL_VARIABLE = 'THP_MOCK_EXTERNAL';

const ENABLED = ['true', '1'];
const DISABLED = ['false', '0', ''];

/**
 * Whether every external provider is mocked.
 *
 * Refuses a value it does not recognise rather than treating it as `false`, matching what
 * `readAsrProvider` does with an unknown provider name. The failure mode this prevents is the
 * expensive one: `THP_MOCK_EXTERNAL=yes` silently meaning *not mocked* is how a development run
 * bills a real transcription.
 */
export function isExternalMocked(env: EnvSource): boolean {
  const configured = (env[MOCK_EXTERNAL_VARIABLE] ?? '').trim().toLowerCase();
  if (ENABLED.includes(configured)) return true;
  if (DISABLED.includes(configured)) return false;
  throw new Error(
    `${MOCK_EXTERNAL_VARIABLE} is "${configured}". It must be one of ${[...ENABLED, ...DISABLED]
      .filter((value) => value !== '')
      .join(', ')}, or unset — see .env.example.`,
  );
}
