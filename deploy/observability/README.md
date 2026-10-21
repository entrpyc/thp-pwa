# deploy/observability — the monitoring setup, as files

What a fresh Grafana Cloud stack needs to look like the one that runs today
(docs/project/observability.md § 6.5). Grafana Cloud Free keeps fourteen days of data; this
directory is what keeps the *configuration* for good.

| File | What it is | Where it goes |
| :--- | :--- | :--- |
| `alloy.alloy` | Grafana Alloy's config: host, Postgres and process exporters, one remote write. | `/etc/alloy/config.alloy` on the box — README.md "Monitoring" |
| `alloy.default` | The four values the config reads from its environment. | `/etc/default/alloy` on the box |
| `healthchecks.env.example` | The three Healthchecks.io ping URLs the backup units and the restore drill use. | `/etc/thp/healthchecks.env` on the box |
| `alerts.json` | The six alert rules, exported from Grafana in its provisioning format. | A Grafana stack — below |
| `dashboards/host.json` | The community *Node Exporter Full* dashboard (id 1860), as exported. | A Grafana stack — below |
| `dashboards/postgres.json` | The community *PostgreSQL Database* dashboard (id 9628), as exported. | A Grafana stack — below |

The box-side files are installed by README.md "Monitoring". This file is about the other three.

## Rebuilding a Grafana stack from these

**Dashboards.** Dashboards → New → Import → "Import via dashboard JSON model" → paste the file.
Both reference the Prometheus data source through a variable (`ds_prometheus` in one,
`DS_PROMETHEUS` in the other) rather than by the stack's own id, so the import asks which data
source to use once; pick the stack's hosted Prometheus. The files are in the dashboard v2 schema
(`dashboard.grafana.app/v2`), which Grafana 12 and later import directly.

**Alert rules.** Alerting → Alert rules → the "More" menu → Import (or "Import alert rules"), file
`alerts.json`, format JSON. Two things to check after the import:

- The rules bind to the data source by uid `grafanacloud-prom`, which is the uid every Grafana
  Cloud stack gives its hosted Prometheus — so a Cloud-to-Cloud rebuild needs no edit. The
  self-hosted fallback in observability.md § 2.5 does: replace it with that instance's data source
  uid before importing.
- Every rule has *No data* and *Error* set to **Alerting**, deliberately (observability.md § 7):
  a host that stops reporting is a host to look at. The export carries these two fields and the
  import honours them.

Then set the contact point: Alerting → Contact points → the default e-mail → the operator's
address → "Test". The rules notify the `default` receiver, so nothing in them names an address.

## Keeping these current

A change made in the UI is not in git until it is exported again. The export routes are in
README.md "Monitoring" and in docs/project/observability.md § 8; the habit is: change the rule,
export the group, commit the file.
