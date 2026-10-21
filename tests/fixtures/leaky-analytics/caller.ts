// A fixture for tests/guards/analytics-boundary.test.ts: both doors, deliberately open.
import posthog from 'posthog-js';

export async function leak(): Promise<void> {
  posthog.capture('note_created', { text: 'the whole note' });
  await fetch('https://eu.i.posthog.com/capture/', { method: 'POST' });
}
