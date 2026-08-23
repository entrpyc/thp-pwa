export {
  deactivateUser,
  findUserByEmail,
  findUserById,
  insertUser,
  listUsers,
  normaliseEmail,
  reactivateUser,
  setUserRole,
  updateDisplayName,
  type GuardedWrite,
  type NewUser,
  type UserRow,
} from './accounts';
export {
  closeDatabase,
  createDatabase,
  getDatabase,
  isUniqueViolation,
  pingDatabase,
  queryable,
  withTransaction,
  type CreateDatabaseOptions,
  type Database,
  type DatabaseHandle,
  type Executor,
  type PingResult,
  type Sql,
  type Transaction,
} from './client';
export { requireDatabaseUrl, type EnvSource } from './env';
export {
  acceptInvitation,
  findInvitationById,
  findInvitationByTokenHash,
  findLiveInvitationByEmail,
  insertInvitation,
  listInvitations,
  revokeInvitation,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type InvitationRow,
  type NewInvitation,
} from './invitations';
export {
  MAX_JOB_ERROR_LENGTH,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  findUnfinishedJob,
  sweepRunning,
  type JobRow,
  type NewJob,
  type ProviderMeta,
  type ReclaimedJob,
} from './jobs';
export { MIGRATIONS_DIR, runMigrations, type RunMigrationsOptions } from './migrate';
export {
  insertNote,
  listNotesForReader,
  type NewNote,
  type NoteRow,
} from './notes';
export {
  findPlaybackProgress,
  setPreferredPlaybackSpeed,
  upsertPlaybackProgress,
  type PlaybackProgressRow,
} from './playback';
export {
  readPipeline,
  type PipelineStepRow,
  type RecordingPipelineRow,
} from './pipeline';
export {
  completePasswordReset,
  findLivePasswordResetForUser,
  findPasswordResetWithUser,
  issuePasswordReset,
  revokePasswordResetsForUser,
  type CompletedPasswordReset,
  type NewPasswordReset,
  type PasswordResetRow,
} from './password-resets';
export {
  findRecordingById,
  insertRecording,
  setRecordingDescription,
  setRecordingPublication,
  type NewRecording,
  type RecordingRow,
} from './recordings';
export {
  closeReviewItem,
  findOpenDraft,
  findReviewItem,
  listPendingReviews,
  replaceOpenDrafts,
  type CloseReviewItem,
  type NewReviewItem,
  type PendingReviewRow,
  type ReviewItemRow,
} from './reviews';
export {
  findSeriesById,
  insertSeries,
  setRecordingSeries,
  updateSeries,
  type NewSeries,
  type SeriesRow,
} from './series';
export {
  findSummaryByRecording,
  publishSummary,
  setSummaryPublication,
  updateSummaryContent,
  type SummaryRow,
} from './summaries';
export {
  findResumeProgress,
  findVisibleRecording,
  findVisibleSeries,
  listVisibleRecordings,
  listVisibleSeries,
  type ResumeProgressRow,
  type VisibilityOptions,
  type VisibleRecordingRow,
  type VisibleSeriesDetail,
  type VisibleSeriesRecordingRow,
  type VisibleSeriesRow,
} from './visibility';
export {
  findLiveSessionByTokenHash,
  insertSession,
  revokeSessionByTokenHash,
  revokeSessionsForUser,
  touchSession,
  type LiveSession,
  type NewSession,
  type SessionRow,
} from './sessions';
export {
  correctSegment,
  findSegmentById,
  findSegmentNeighbours,
  findTranscriptByRecording,
  listSegments,
  replaceTranscript,
  type NewSegmentText,
  type NewTranscript,
  type SegmentCorrection,
  type SegmentNeighbours,
  type SegmentRow,
  type TranscriptRow,
} from './transcripts';
export * as schema from './schema';
