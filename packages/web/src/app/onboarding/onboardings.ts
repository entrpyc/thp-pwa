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

function onboardingSlide(
  id: OnboardingId,
  n: number,
  title: string,
  description: string,
  extension: 'mp4' | 'webp' = 'mp4',
): OnboardingSlide {
  return { media: `/onboarding/${id}/slide-${n}.${extension}`, title, description };
}

const NEW_USER_ONBOARDING: OnboardingDefinition = {
  slides: [
    onboardingSlide(
      'new-user',
      1,
      "Quick tour before you start",
      "To play a recording click on the link to all series, then choose a series to see its' recordings. Once you are on the recording page, click on the play button. Opening the app from a different device or coming back to a recording will resume your progress from wherever you left off.",
    ),
    onboardingSlide(
      'new-user',
      2,
      'Adding a note',
      'You can share your thoughts with the group or keep private notes. On the recording page, scroll to the "Notes" tab. Type in your note and choose to keep it private or public. Click on "Save note" and your note is now displayed below.',
    ),
    onboardingSlide(
      'new-user',
      3,
      'Browsing and interacting with notes',
      'You can filter notes by visibility, use reactions, click on their timestamps to jump to that moment in the recording, edit or delete your note, and also reply to any public note.',
    ),
    onboardingSlide(
      'new-user',
      4,
      'Chapters',
      'Each recording is divided into chapters - themes that appear in the recording. Scroll to the "Chapters" tab and click it. A list of chapters will be displayed. Click on the play button next to a chapter to jump to that moment in the recording, or click on the chapter title to open the chapter\'s page.',
    ),
    onboardingSlide(
      'new-user',
      5,
      'Playback controls',
      'The playback menu on the bottom is visible and interactive in any page. You can pause, play, skip forward or backward. The playback track contains indicators for notes (green dots) and chapters (grey lines) that appear in the recording.',
    ),
    onboardingSlide(
      'new-user',
      6,
      'Speed control and quick actions',
      'In the playback menu, you can change the speed of the recording by clicking on the speed button. You can also click-hold and drag to select specific speed. The quick action menu allows you to add a note, or enable captions. You can use it by clicking on the button, or click-hold and drag to select a specific action from the menu.',
    ),
    onboardingSlide(
      'new-user',
      7,
      'Page navigation with breadcrumb',
      'Quickly navigate back. In the top navigation you can see the path to the current page in the format "Homepage > Series > Recording > Chapter". You can click on any of the items in the breadcrumb to navigate to that page.',
    ),
    onboardingSlide(
      'new-user',
      8,
      'Top navigation menu',
      'Need to browse a list of all series or all recordings? You can navigate using the top-right button.',
    ),
    onboardingSlide(
      'new-user',
      9,
      'Feedback and bug report',
      'Anything feels off or you have ideas for the app? Click on the top-right button and select the "Report a bug" link. You can fill out the form and submit it, that would be greatly appreciated.',
    ),
    onboardingSlide(
      'new-user',
      10,
      'Install the app',
      'Want quick access from your home screen? Click on the top-right button and select the "Install app". Follow the instructions to add the app to your home screen. You can also install the app from your browser\'s menu.',
      'webp',
    ),
  ],
};
const RELEASE_0_3_0_ONBOARDING: OnboardingDefinition = {
  slides: [
    onboardingSlide(
      'release-0.3.0',
      1,
      'Notifications',
      'You will now get in-app notifications when a new recording is available, when someone replies or reacts to your note, for new features, or when the admin publishes an announcement.',
      'webp',
    ),
    onboardingSlide(
      'release-0.3.0',
      2,
      'Personal Profile',
      'From the top-right menu, you can access the "My Profile" page. Here you can change your display name and profile picture.',
      'webp',
    ),
  ]
}

export const ONBOARDINGS: Record<OnboardingId, OnboardingDefinition> = {
  'new-user': NEW_USER_ONBOARDING,
  'release-0.3.0': RELEASE_0_3_0_ONBOARDING,
};
