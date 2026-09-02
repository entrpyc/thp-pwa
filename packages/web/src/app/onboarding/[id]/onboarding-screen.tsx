'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { onboardingCompletionPath, type OnboardingId } from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import type { OnboardingSlide } from '../onboardings';
import styles from './onboarding.module.css';

/** How far a touch has to travel horizontally before it reads as a swipe rather than a tap. */
const SWIPE_THRESHOLD_PX = 48;

/**
 * The onboarding player: one slide at a time, moved by the arrows, a swipe, the arrow keys or the
 * dots, with two ways out — Skip at any point, "Let's Start" on the last slide.
 *
 * **Both exits record the completion**, deliberately: skipping is an answer to "show me this
 * again?" just as finishing is, and a Skip that replayed the tour at every sign-in would punish
 * the person who declined it. The write is fire-and-forget on top of the navigation — if it fails,
 * the only consequence is that the tour offers itself once more next sign-in, which is strictly
 * better than trapping somebody in it behind an error.
 *
 * A slide's media is a silent looping video or a still image, decided by extension. Only the
 * active slide's video plays; the rest are paused so nine videos do not decode at once.
 */
export function OnboardingScreen({
  onboardingId,
  slides,
}: {
  onboardingId: OnboardingId;
  slides: readonly OnboardingSlide[];
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);

  const lastIndex = slides.length - 1;

  function goTo(next: number): void {
    setIndex(Math.max(0, Math.min(lastIndex, next)));
  }

  // Play the active slide's video, pause every other. Muted playback needs no gesture, and
  // `play()` on a video still loading simply starts it — both rejections are ignorable.
  useEffect(() => {
    videos.current.forEach((video, i) => {
      if (video === null) return;
      if (i === index) void video.play().catch(() => undefined);
      else video.pause();
    });
  }, [index]);

  // The arrow keys page exactly as the on-screen arrows do.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(lastIndex, i + 1));
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lastIndex]);

  async function leave(): Promise<void> {
    if (leaving) return;
    setLeaving(true);
    try {
      await apiFetch(onboardingCompletionPath(onboardingId), {
        method: 'PUT',
        credentials: 'include',
      });
    } catch {
      // Not recorded means the tour replays next sign-in — an annoyance, never a trap.
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <button className={styles.skip} type="button" onClick={() => void leave()} disabled={leaving}>
          Skip
        </button>
      </header>

      <div className={styles.stage}>
        <button
          className={styles.arrow}
          type="button"
          aria-label="Previous slide"
          disabled={index === 0}
          onClick={() => goTo(index - 1)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M15 5l-7 7 7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <div
          className={styles.viewport}
          onTouchStart={(event) => {
            touchStartX.current = event.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(event) => {
            const start = touchStartX.current;
            touchStartX.current = null;
            const end = event.changedTouches[0]?.clientX;
            if (start === null || end === undefined) return;
            const delta = end - start;
            if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
            goTo(index + (delta < 0 ? 1 : -1));
          }}
        >
          <ul
            className={styles.track}
            style={{ transform: `translateX(-${index * 100}%)` }}
          >
            {slides.map((slide, i) => (
              <li
                key={slide.media}
                className={styles.slide}
                aria-hidden={i !== index}
                // `inert` is what makes aria-hidden true: nothing on an off-screen slide can be
                // focused or clicked, including the last slide's start button.
                inert={i !== index ? true : undefined}
              >
                <div className={styles.media}>
                  {slide.media.endsWith('.mp4') ? (
                    <video
                      ref={(element) => {
                        videos.current[i] = element;
                      }}
                      src={slide.media}
                      muted
                      loop
                      playsInline
                      preload={i === 0 ? 'auto' : 'metadata'}
                    />
                  ) : (
                    // Decorative alongside the title and description, which carry the words.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={slide.media} alt="" />
                  )}
                </div>
                <h2 className={styles.title}>{slide.title}</h2>
                <p className={styles.description}>{slide.description}</p>
                {i === lastIndex ? (
                  <button
                    className={styles.start}
                    type="button"
                    onClick={() => void leave()}
                    disabled={leaving}
                  >
                    {leaving ? 'Starting…' : 'Let’s Start'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <button
          className={styles.arrow}
          type="button"
          aria-label="Next slide"
          disabled={index === lastIndex}
          onClick={() => goTo(index + 1)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M9 5l7 7-7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className={styles.dots}>
        {slides.map((slide, i) => (
          <button
            key={slide.media}
            className={i === index ? styles.dotActive : styles.dot}
            type="button"
            aria-label={`Go to slide ${i + 1} of ${slides.length}`}
            aria-current={i === index}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
    </div>
  );
}
