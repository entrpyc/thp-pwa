/**
 * pm2 — **the two supervised processes**, and the one setting that would break the worker.
 *
 * `.cjs` rather than `.js` because the repository is `"type": "module"` and pm2 `require`s this
 * file.
 *
 * Both apps run through `npm`, so the command a deployment supervises is the same command
 * README.md documents — and both therefore load the repository-root `.env` through
 * `scripts/with-env.mjs`, exactly as they do in development. There is no second idea of what
 * "start the app" means.
 *
 * **`exec_mode: 'fork'` with `instances: 1` on the worker is not a default worth changing.** pm2's
 * cluster mode runs N copies of a process, and the worker's boot sweep reclaims every job left
 * `running` by a worker that died — so a second copy would reclaim jobs the first one is still
 * running, mid-transcription. One process is also what
 * docs/project/architecture.md § Estimated running costs pins concurrency to, for a different
 * reason: four shared vCPU with Postgres on the same box.
 *
 * Deliberately not here: `max_memory_restart`, a cron restart, cluster mode for the web process,
 * and log paths. pm2's defaults cover all of them, and `pm2-logrotate` is what bounds the logs —
 * installed as a module on the box, because a 100 GB disk and an unbounded log file end one way.
 */
module.exports = {
  apps: [
    {
      name: 'thp-web',
      script: 'npm',
      args: 'start',
      interpreter: 'none',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // A process that cannot start at all should not spin: back off rather than hammer.
      restart_delay: 5000,
    },
    {
      name: 'thp-worker',
      script: 'npm',
      args: 'run worker',
      interpreter: 'none',
      cwd: __dirname,
      // See the note above. Neither of these two lines is safe to change on its own.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
    },
  ],
};
