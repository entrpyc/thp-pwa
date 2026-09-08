import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOUND_PROFILE,
  SOUND_PROFILE_LOUDNESS_RANGE_LU,
  SOUND_PROFILE_TRUE_PEAK_DBTP,
  checkSoundProfileSettings,
  sameSoundProfileSettings,
} from '@thp/shared';
import {
  AudioProcessingError,
  OUTPUT_SAMPLE_RATE,
  PLAYBACK_BITRATE,
  buildFilterGraph,
  encodeArguments,
  measureArguments,
  parseLoudnormMeasurement,
  type LoudnessMeasurement,
} from '../../src/audio';
import { readPreviewPayload } from '../../src/preview-audio';

/**
 * The sound profile as a filter chain ([3.4.2](docs/project/prd.md)–[3.4.5](docs/project/prd.md);
 * project tdd 4.8), held at the seam where a profile becomes an ffmpeg command line.
 *
 * ffmpeg itself is not run here — the suite's machines have none — so what is pinned is the
 * command it would be given: which stages a knob turns on, in what order, with what numbers, and
 * how the first pass's measurement becomes the second pass's arguments. That is the whole of the
 * translation, and the one place a wrong decibel would otherwise hide.
 */

const MEASURED: LoudnessMeasurement = {
  inputI: -23.4,
  inputTp: -3.1,
  inputLra: 9.8,
  inputThresh: -33.9,
  targetOffset: 0.6,
};

describe('buildFilterGraph', () => {
  it('runs denoise, then clarity, then loudness, in that order', () => {
    const graph = buildFilterGraph(DEFAULT_SOUND_PROFILE, null);
    const stages = graph.split(',').map((stage) => stage.split('=')[0]);
    expect(stages).toEqual(['afftdn', 'highpass', 'equalizer', 'acompressor', 'loudnorm']);
  });

  it('carries each knob into its stage, and the two fixed loudness parameters with them', () => {
    const graph = buildFilterGraph(
      { noiseReductionDb: 20, voiceClarityDb: 4, loudnessTargetLufs: -18 },
      null,
    );
    expect(graph).toContain('afftdn=nr=20:tn=1');
    expect(graph).toContain('equalizer=f=3000:width_type=o:width=2:g=4');
    expect(graph).toContain(
      `loudnorm=I=-18:TP=${SOUND_PROFILE_TRUE_PEAK_DBTP}:LRA=${SOUND_PROFILE_LOUDNESS_RANGE_LU}`,
    );
  });

  it('skips the denoiser at zero, and the whole clarity stage at zero', () => {
    const noDenoise = buildFilterGraph(
      { noiseReductionDb: 0, voiceClarityDb: 3, loudnessTargetLufs: -16 },
      null,
    );
    expect(noDenoise).not.toContain('afftdn');
    expect(noDenoise).toContain('highpass');

    const noClarity = buildFilterGraph(
      { noiseReductionDb: 12, voiceClarityDb: 0, loudnessTargetLufs: -16 },
      null,
    );
    expect(noClarity).toContain('afftdn');
    for (const stage of ['highpass', 'equalizer', 'acompressor']) {
      expect(noClarity, stage).not.toContain(stage);
    }

    // Loudness is never skipped: it is the one thing every recording shares (3.4.4).
    const nothingElse = buildFilterGraph(
      { noiseReductionDb: 0, voiceClarityDb: 0, loudnessTargetLufs: -16 },
      null,
    );
    expect(nothingElse).toMatch(/^loudnorm=/);
  });

  it('measures on the first pass and normalises linearly on the second, from what was measured', () => {
    const first = buildFilterGraph(DEFAULT_SOUND_PROFILE, null);
    expect(first).toContain('print_format=json');
    expect(first).not.toContain('measured_I');

    const second = buildFilterGraph(DEFAULT_SOUND_PROFILE, MEASURED);
    expect(second).toContain('measured_I=-23.4');
    expect(second).toContain('measured_TP=-3.1');
    expect(second).toContain('measured_LRA=9.8');
    expect(second).toContain('measured_thresh=-33.9');
    expect(second).toContain('offset=0.6');
    expect(second).toContain('linear=true');
    expect(second).not.toContain('print_format=json');

    // The stages before loudnorm are identical, which is what makes the measurement apply.
    const before = (graph: string) => graph.slice(0, graph.indexOf('loudnorm='));
    expect(before(second)).toBe(before(first));
  });
});

describe('the command lines', () => {
  it('measures to nowhere, audibly enough to print the measurement', () => {
    const args = measureArguments({ sourcePath: '/tmp/s', profile: DEFAULT_SOUND_PROFILE });
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(args).toContain('info');
    expect(args).not.toContain('-y');
  });

  it('encodes AAC in a fast-start MP4 at the playback bitrate and a sane rate, with or without a chain', () => {
    const plain = encodeArguments({
      sourcePath: '/tmp/s',
      renditionPath: '/tmp/r.m4a',
      filterGraph: null,
    });
    expect(plain).not.toContain('-af');
    expect(plain).toEqual(expect.arrayContaining(['-vn', '-c:a', 'aac', '-b:a', PLAYBACK_BITRATE]));
    expect(plain).toEqual(expect.arrayContaining(['-ar', OUTPUT_SAMPLE_RATE, '-movflags', '+faststart']));
    expect(plain.at(-1)).toBe('/tmp/r.m4a');

    const graph = buildFilterGraph(DEFAULT_SOUND_PROFILE, MEASURED);
    const filtered = encodeArguments({
      sourcePath: '/tmp/s',
      renditionPath: '/tmp/r.m4a',
      filterGraph: graph,
    });
    expect(filtered[filtered.indexOf('-af') + 1]).toBe(graph);
  });

  it('seeks the input for an excerpt rather than decoding up to it', () => {
    const args = encodeArguments({
      sourcePath: '/tmp/s',
      renditionPath: '/tmp/r.m4a',
      filterGraph: null,
      excerpt: { startSeconds: 60, durationSeconds: 30 },
    });
    const seek = args.indexOf('-ss');
    expect(args.slice(seek, seek + 4)).toEqual(['-ss', '60', '-t', '30']);
    expect(seek).toBeLessThan(args.indexOf('-i'));
  });
});

describe('parseLoudnormMeasurement', () => {
  const STDERR = [
    'Input #0, mp3, from \'/tmp/s\':',
    '  Duration: 01:12:03.41, start: 0.025057, bitrate: 128 kb/s',
    '[Parsed_loudnorm_1 @ 0x55] ',
    '{',
    '\t"input_i" : "-23.40",',
    '\t"input_tp" : "-3.10",',
    '\t"input_lra" : "9.80",',
    '\t"input_thresh" : "-33.90",',
    '\t"output_i" : "-16.10",',
    '\t"output_tp" : "-1.50",',
    '\t"output_lra" : "9.10",',
    '\t"output_thresh" : "-26.60",',
    '\t"normalization_type" : "dynamic",',
    '\t"target_offset" : "0.60"',
    '}',
  ].join('\n');

  it('reads the five numbers the second pass needs out of everything else ffmpeg says', () => {
    expect(parseLoudnormMeasurement(STDERR)).toEqual(MEASURED);
  });

  it('fails in words when there is no measurement, and when the excerpt measured as silence', () => {
    expect(() => parseLoudnormMeasurement('Output file is empty, nothing was encoded')).toThrow(
      AudioProcessingError,
    );
    expect(() => parseLoudnormMeasurement('nothing')).toThrow(/printed no measurement/);

    const silent = STDERR.replace('"-23.40"', '"-inf"');
    expect(() => parseLoudnormMeasurement(silent)).toThrow(/holds no audio/);
  });
});

describe('the preview payload', () => {
  it('is the settings and a start, checked again on the worker', () => {
    const read = readPreviewPayload({ settings: DEFAULT_SOUND_PROFILE, startSeconds: 45 });
    expect(sameSoundProfileSettings(read.settings, DEFAULT_SOUND_PROFILE)).toBe(true);
    expect(read.startSeconds).toBe(45);
  });

  it('refuses what the API would have refused, in case a row was written by another hand', () => {
    expect(() => readPreviewPayload(null)).toThrow(/carries no settings/);
    expect(() =>
      readPreviewPayload({ settings: { ...DEFAULT_SOUND_PROFILE, noiseReductionDb: 99 }, startSeconds: 0 }),
    ).toThrow(/Noise reduction/);
    expect(() => readPreviewPayload({ settings: DEFAULT_SOUND_PROFILE })).toThrow(/no start/);
    // The same sentence the API prints, from the same check.
    expect(checkSoundProfileSettings({ ...DEFAULT_SOUND_PROFILE, voiceClarityDb: 2.5 })).toMatch(
      /whole number/,
    );
  });
});
