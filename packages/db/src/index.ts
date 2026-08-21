export {
  findUserByEmail,
  findUserById,
  insertUser,
  normaliseEmail,
  type NewUser,
  type UserRow,
} from './accounts';
export {
  closeDatabase,
  createDatabase,
  getDatabase,
  pingDatabase,
  type CreateDatabaseOptions,
  type Database,
  type DatabaseHandle,
  type PingResult,
  type Sql,
} from './client';
export { requireDatabaseUrl } from './env';
export { MIGRATIONS_DIR, runMigrations, type RunMigrationsOptions } from './migrate';
export {
  findLiveSessionByTokenHash,
  insertSession,
  revokeSessionByTokenHash,
  touchSession,
  type LiveSession,
  type NewSession,
  type SessionRow,
} from './sessions';
export * as schema from './schema';
