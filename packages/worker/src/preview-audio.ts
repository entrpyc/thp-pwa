import { findRecordingById, type JobRow, type ProviderMeta } from '@thp/db';
import { mediaStore, mintPreviewKey, type PreviewSide } from '@thp/media';
import {
  PREVIEW_EXCERPT_SECONDS,
  checkSoundProfileSettings,
  pickSoundProfileSettings,
  type SoundProfileSettings,
} from '@thp/shared';
import { logger } from '@thp/shared/observability/logger';
import { audioProcessor as configuredProcessor } from './audio';
import type { JobHandler } from './handlers';
import { PROCESS_AUDIO_GRANT_SECONDS, extensionOf, type ProcessAudioDependencies } from './process-audio';

/**
 * **The `preview_audio` step** ([3.4.6](docs/project/prd.md)) — thirty seconds of one teaching,
 * twice: the original transcoded plain, and the same excerpt under the settings the admin is
 * about to save. A standalone step: it is in the ledger so the worker runs it and an operator can
 * read it, and outside the chain so nothing follows it.
 *
 * **It repoints nothing.** The recording keeps its rendition; what the step leaves is two objects
 * under `preview/` keys and their names in `provider_meta`, which is what the console reads back
 * to mint two signed URLs. The settings come off `job.payload` and nowhere else — a preview is of
 * settings nobody has saved, which is the whole reason it exists — and they are checked here
 * again, because a row in a table is not a request the API validated a minute ago.
 *
 * "Before" is rendered by the same processor with **no profile**, rather than by serving the
 * original: a fresh encode of the same thirty seconds is what makes the two sides differ by the
 * profile and by nothing else, and it is what makes them both play in a browser whatever the
 * original was.
 */

/** What a preview asks for, as the API writes it into `job.payload`. */
export interface PreviewAudioPayload {
  readonly settings: SoundProfileSettings;
  readonly startSeconds: number;
}

/** What the step leaves in `provider_meta` — the console's way to the two objects. */
export interface PreviewAudioResult {
  readonly tool: string;
  readonly beforeKey: string;
  readonly afterKey: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly settings: SoundProfileSettings;
}

export function readPreviewPayload(payload: unknown): PreviewAudioPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('the preview job carries no settings');
  }
  const { settings, startSeconds } = payload as Partial<PreviewAudioPayload>;
  const refused = checkSoundProfileSettings(settings);
  if (refused !== null) throw new Error(`the preview job's settings were refused: ${refused}`);
  if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new Error('the preview job names no start position');
  }
  return {
    settings: pickSoundProfileSettings(settings as SoundProfileSettings),
    startSeconds,
  };
}

export function createPreviewAudioHandler(deps: ProcessAudioDependencies = {}): JobHandler {
  return async function previewAudio(job: JobRow): Promise<ProviderMeta> {
    const fields = { jobId: job.id, recordingId: job.recordingId };
    logger.info('preview_audio.started', fields);

    try {
      const result = await producePreview(job, deps);
      const providerMeta: ProviderMeta = { ...result, costUsd: 0 };
      logger.info('preview_audio.succeeded', { ...fields, ...providerMeta });
      return providerMeta;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.error('preview_audio.failed', {
        ...fields,
        reason,
        ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
      });
      throw new Error(reason);
    }
  };
}

async function producePreview(
  job: JobRow,
  deps: ProcessAudioDependencies,
): Promise<PreviewAudioResult> {
  const media = deps.media ?? mediaStore();
  const processor = deps.processor ?? configuredProcessor();
  const { settings, startSeconds } = readPreviewPayload(job.payload);

  const recording = await findRecordingById(job.recordingId, deps.executor);
  if (!recording) throw new Error(`no recording ${job.recordingId}`);

  const sourceKey = recording.originalMediaKey;
  const source = await media.head(sourceKey);
  if (source === null) throw new Error(`no object at key "${sourceKey}"`);

  const rendition = processor.outputFor(extensionOf(sourceKey), source.contentType);
  const sourceUrl = await media.presignGet({
    key: sourceKey,
    expiresInSeconds: PROCESS_AUDIO_GRANT_SECONDS,
  });
  const excerpt = { startSeconds, durationSeconds: PREVIEW_EXCERPT_SECONDS };

  const render = async (side: PreviewSide, profile: SoundProfileSettings | null) => {
    const key = mintPreviewKey(side, rendition.extension);
    const uploadUrl = await media.presignPut({
      key,
      contentType: rendition.contentType,
      expiresInSeconds: PROCESS_AUDIO_GRANT_SECONDS,
    });
    await processor.process({
      sourceUrl,
      uploadUrl,
      contentType: rendition.contentType,
      profile,
      excerpt,
    });
    if ((await media.head(key)) === null) {
      throw new Error(`${processor.name} reported success but nothing is at "${key}"`);
    }
    return key;
  };

  // The plain side first: if the excerpt is empty it fails here, before the profile is spent on
  // it, and with the same sentence either way.
  const beforeKey = await render('before', null);
  const afterKey = await render('after', settings);

  return {
    tool: processor.name,
    beforeKey,
    afterKey,
    startSeconds,
    durationSeconds: PREVIEW_EXCERPT_SECONDS,
    settings,
  };
}
