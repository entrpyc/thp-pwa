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

type MediaExtension = 'mp4' | 'webp';

interface SlideCopy {
  readonly title: string;
  readonly description: string;
  /** Defaults to `mp4`; set `webp` for a still image. */
  readonly extension?: MediaExtension;
}

/**
 * Builds the definition for one onboarding. Slides are numbered by position (1-based) and their
 * media resolved to `/onboarding/{id}/slide-{n}.{extension}`, so a slide only carries its copy
 * and, when it is a still image, the extension.
 */
function onboarding(id: OnboardingId, slides: readonly SlideCopy[]): OnboardingDefinition {
  return {
    slides: slides.map(({ title, description, extension = 'mp4' }, i) => ({
      media: `/onboarding/${id}/slide-${i + 1}.${extension}`,
      title,
      description,
    })),
  };
}

export const ONBOARDINGS: Record<OnboardingId, OnboardingDefinition> = {
  'new-user': onboarding('new-user', [
    {
      title: 'Quick tour before you start',
      description:
        "To play a recording click on the link to all series, then choose a series to see its' recordings. Once you are on the recording page, click on the play button. Opening the app from a different device or coming back to a recording will resume your progress from wherever you left off.",
    },
    {
      title: 'Adding a note',
      description:
        'You can share your thoughts with the group or keep private notes. On the recording page, scroll to the "Notes" tab. Type in your note and choose to keep it private or public. Click on "Save note" and your note is now displayed below.',
    },
    {
      title: 'Browsing and interacting with notes',
      description:
        'You can filter notes by visibility, use reactions, click on their timestamps to jump to that moment in the recording, edit or delete your note, and also reply to any public note.',
    },
    {
      title: 'Chapters',
      description:
        'Each recording is divided into chapters - themes that appear in the recording. Scroll to the "Chapters" tab and click it. A list of chapters will be displayed. Click on the play button next to a chapter to jump to that moment in the recording, or click on the chapter title to open the chapter\'s page.',
    },
    {
      title: 'Playback controls',
      description:
        'The playback menu on the bottom is visible and interactive in any page. You can pause, play, skip forward or backward. The playback track contains indicators for notes (green dots) and chapters (grey lines) that appear in the recording.',
    },
    {
      title: 'Speed control and quick actions',
      description:
        'In the playback menu, you can change the speed of the recording by clicking on the speed button. You can also click-hold and drag to select specific speed. The quick action menu allows you to add a note, or enable captions. You can use it by clicking on the button, or click-hold and drag to select a specific action from the menu.',
    },
    {
      title: 'Page navigation with breadcrumb',
      description:
        'Quickly navigate back. In the top navigation you can see the path to the current page in the format "Homepage > Series > Recording > Chapter". You can click on any of the items in the breadcrumb to navigate to that page.',
    },
    {
      title: 'Top navigation menu',
      description:
        'Need to browse a list of all series or all recordings? You can navigate using the top-right button.',
    },
    {
      title: 'Feedback and bug report',
      description:
        'Anything feels off or you have ideas for the app? Click on the top-right button and select the "Report a bug" link. You can fill out the form and submit it, that would be greatly appreciated.',
    },
    {
      title: 'Install the app',
      description:
        'Want quick access from your home screen? Click on the top-right button and select the "Install app". Follow the instructions to add the app to your home screen. You can also install the app from your browser\'s menu.',
      extension: 'webp',
    },
  ]),
  'release-0.3.0': onboarding('release-0.3.0', [
    {
      title: 'Notifications',
      description:
        'You will now get in-app notifications when a new recording is available, when someone replies or reacts to your note, for new features, or when the admin publishes an announcement.',
      extension: 'webp',
    },
    {
      title: 'Personal Profile',
      description:
        'From the top-right menu, you can access the "My Profile" page. Here you can change your display name and profile picture.',
      extension: 'webp',
    },
  ]),
};
