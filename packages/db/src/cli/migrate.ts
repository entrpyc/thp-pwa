import { requireDatabaseUrl } from '../env';
import { runMigrations } from '../migrate';

/** The connection target, with any password removed — safe to print. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString().replace(':@', '@');
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/** Every message down the cause chain, so the real reason is on the first line, not the fifth. */
function causeChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 6) {
    messages.push(current.message.split('\n')[0] ?? current.message);
    current = current.cause;
  }
  return messages.length > 0 ? messages : [String(error)];
}

function hintFor(messages: readonly string[]): string | null {
  const joined = messages.join(' ');
  if (joined.includes('ECONNREFUSED') || joined.includes('CONNECT_TIMEOUT')) {
    return 'Nothing is listening there. Start the development database with `docker compose up -d`.';
  }
  if (joined.includes('password authentication failed') || joined.includes('SASL')) {
    return 'The credentials in DATABASE_URL were rejected. Check .env against docker-compose.yml.';
  }
  if (joined.includes('does not exist')) {
    return 'The database named in DATABASE_URL does not exist. Create it, or fix the name in .env.';
  }
  return null;
}

/** `npm run migrate` — the one command that brings an empty database up to date. */
async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  try {
    await runMigrations({ url });
  } catch (error) {
    const messages = causeChain(error);
    const hint = hintFor(messages);
    process.stderr.write(
      [
        `Migration failed against ${describeTarget(url)}`,
        ...messages.map((message) => `  ${message}`),
        ...(hint ? ['', `  ${hint}`] : []),
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Migrations applied to ${describeTarget(url)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
