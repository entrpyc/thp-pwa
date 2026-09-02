import type { OnboardingId } from '@thp/shared';

/**
 * **What each onboarding shows** — the slides, their copy and their media.
 *
 * Presentation, so it lives with the screen rather than in `@thp/shared`: the shared list owns
 * *which onboardings exist* (three parties have to agree on that), and this file owns what they
 * look like, which only the screen reads. The `Record<OnboardingId, …>` is the seam between the
 * two — an id added to the shared list stops the build here until its slides exist.
 *
 * Media files live under `public/onboarding/{id}/` and a slide points at one by absolute path. A
 * `.mp4` renders as a silent looping video, a `.webp` as a still image — the screen decides by
 * extension, so swapping one for the other is renaming the file and editing the path here.
 */

export interface OnboardingSlide {
  /** Absolute path under `public/`, e.g. `/onboarding/new-user/slide-1.mp4` or `….webp`. */
  readonly media: string;
  readonly title: string;
  readonly description: string;
}

export interface OnboardingDefinition {
  readonly slides: readonly OnboardingSlide[];
}

function newUserSlide(
  n: number,
  title: string,
  description: string,
  extension: 'mp4' | 'webp' = 'mp4',
): OnboardingSlide {
  return { media: `/onboarding/new-user/slide-${n}.${extension}`, title, description };
}

/*
 * Every title and description below is draft copy awaiting the real wording, and every media path
 * assumes an `.mp4` — edit the extension per slide as the real files land in
 * `public/onboarding/new-user/`.
 */
export const ONBOARDINGS: Record<OnboardingId, OnboardingDefinition> = {
  'new-user': {
    slides: [
      newUserSlide(
        1,
        "Quick tour before you start",
        "To play a recording click on the link to all series, then choose a series to see its' recordings. Once you are on the recording page, click on the play button.",
      ),
      newUserSlide(
        2,
        'Adding a note',
        'You can share your thoughts with the group or keep private notes. On the recording page, scroll to the "Notes" tab. Type in your note and choose to keep it private or public. Click on "Save note" and your note is now displayed below.',
      ),
      newUserSlide(
        3,
        'Browsing and interacting with notes',
        'You can filter notes by visibility, use reactions, click on their timestamps to jump to that moment in the recording, edit or delete your note, and also reply to any public note.',
      ),
      newUserSlide(
        4,
        'Chapters',
        'Each recording is divided into chapters - themes that appear in the recording. Scroll to the "Chapters" tab and click it. A list of chapters will be displayed. Click on the play button next to a chapter to jump to that moment in the recording, or click on the chapter title to open the chapter\'s page.',
      ),
      newUserSlide(
        5,
        'Playback controls',
        'The playback menu on the bottom is visible and interactive in any page. You can pause, play, skip forward or backward. The playback track contains indicators for notes (green dots) and chapters (grey lines) that appear in the recording.',
      ),
      newUserSlide(
        6,
        'Speed control and quick actions',
        'In the playback menu, you can change the speed of the recording by clicking on the speed button. You can also click-hold and drag to select specific speed. The quick action menu allows you to add a note, or enable captions. You can use it by clicking on the button, or click-hold and drag to select a specific action from the menu.',
      ),
      newUserSlide(
        7,
        'Page navigation with breadcrumb',
        'Quickly navigate back. In the top navigation you can see the path to the current page in the format "Homepage > Series > Recording > Chapter". You can click on any of the items in the breadcrumb to navigate to that page.',
      ),
      newUserSlide(
        8,
        'Top navigation menu',
        'Need to browse a list of all series or all recordings? You can navigate using the top-right button.',
      ),
      newUserSlide(
        9,
        'Feedback and bug report',
        'Anything feels off or you have ideas for the app? Click on the top-right button and select the "Report a bug" link. You can fill out the form and submit it, that would be greatly appreciated.',
      ),
      newUserSlide(
        10,
        'Install the app',
        'Want quick access from your home screen? Click on the top-right button and select the "Install app". Follow the instructions to add the app to your home screen. You can also install the app from your browser\'s menu.',
        'webp',
      ),
    ],
  },
};
