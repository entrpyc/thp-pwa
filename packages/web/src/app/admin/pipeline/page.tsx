import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { PipelinePanel } from './pipeline-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/pipeline` — the console's third panel: what the pipeline is doing to every recording,
 * and the one control that makes it do a step again.
 *
 * **This is the panel that makes a failure something an operator reads rather than discovers.** A
 * failed `transcribe` halts the chain (docs/project/prd.md, 3.21.2.3) and a low-confidence
 * transcript fails its job on purpose (3.5.8); until this screen existed, neither was visible
 * anywhere but a log line.
 *
 * The same carve-out the first two panels took — no admin reference PNG exists, so it is composed
 * from docs/design-references/style-guide.md and the token layer, and `pipeline.module.css`
 * composes from `admin.module.css` rather than restating it, so the three panels cannot drift.
 *
 * **The gate decides what to render and authorises nothing.** `GET /api/v1/pipeline` and the
 * re-run route refuse a member independently, and the suite drives that refusal directly rather
 * than trusting this redirect.
 */
export default async function AdminPipelinePage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'pipeline.read')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="pipeline">
      <PipelinePanel />
    </ConsoleShell>
  );
}
