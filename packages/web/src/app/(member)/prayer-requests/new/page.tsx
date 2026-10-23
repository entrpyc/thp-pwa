import { RaiseForm } from './raise-form';

export const dynamic = 'force-dynamic';

/** `/prayer-requests/new` — the form that raises a signal ([3.16.1](docs/project/prd.md)). */
export default function RaiseSosPage() {
  return <RaiseForm />;
}
