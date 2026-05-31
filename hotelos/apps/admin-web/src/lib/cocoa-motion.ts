/**
 * CocoaMotion - Cocoa-style animation presets and utilities.
 *
 * Provides spring/easing curves, duration tokens, CSS-in-JS helpers
 * for common entrance animations, and a hook to respect the user's
 * reduced-motion preference.
 *
 * Pair this module with `src/styles/cocoa-motion.css`, which defines
 * the @keyframes referenced by the helpers below.
 */

import { useEffect, useState } from 'react';
import type React from 'react';

/**
 * Cocoa-style cubic-bezier easing curves.
 * Use as the timing-function in `animation` / `transition` shorthand.
 */
export const cocoaSpring = {
  default: 'cubic-bezier(0.32, 0.72, 0, 1)',
  bouncy: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  gentle: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  quick: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/**
 * Cocoa duration tokens, in milliseconds.
 */
export const cocoaDuration = {
  instant: 100,
  fast: 150,
  base: 200,
  slow: 300,
  slower: 400,
} as const;

export type CocoaSpringKey = keyof typeof cocoaSpring;
export type CocoaDurationKey = keyof typeof cocoaDuration;

/**
 * Fade in from opacity 0 to 1.
 */
export function fadeIn(duration: number = cocoaDuration.base): React.CSSProperties {
  return { animation: `cocoa-fade-in ${duration}ms ${cocoaSpring.default} both` };
}

/**
 * Scale in from 0.96 to 1 with a bouncy spring.
 */
export function scaleIn(duration: number = cocoaDuration.base): React.CSSProperties {
  return { animation: `cocoa-scale-in ${duration}ms ${cocoaSpring.bouncy} both` };
}

/**
 * Slide in from below (translateY positive -> 0).
 */
export function slideInUp(duration: number = cocoaDuration.base): React.CSSProperties {
  return { animation: `cocoa-slide-in-up ${duration}ms ${cocoaSpring.default} both` };
}

/**
 * Slide in from the right (translateX positive -> 0).
 */
export function slideInRight(duration: number = cocoaDuration.base): React.CSSProperties {
  return { animation: `cocoa-slide-in-right ${duration}ms ${cocoaSpring.default} both` };
}

/**
 * Slide in from above (translateY negative -> 0).
 */
export function slideInDown(duration: number = cocoaDuration.base): React.CSSProperties {
  return { animation: `cocoa-slide-in-down ${duration}ms ${cocoaSpring.default} both` };
}

/**
 * Slide in from the left (translateX negative -> 0).
 */
export function slideInLeft(duration: number = cocoaDuration.base): React.CSSProperties {
  return { animation: `cocoa-slide-in-left ${duration}ms ${cocoaSpring.default} both` };
}

/**
 * Returns `true` when motion should be reduced.
 *
 * Sources, in order of precedence:
 *  1. `document.documentElement` has attribute `data-cocoa-reduced-motion`
 *     set to anything other than `"false"`.
 *  2. `window.matchMedia('(prefers-reduced-motion: reduce)')` matches.
 *
 * Re-evaluates on attribute mutation and media-query change.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => computeReducedMotion());

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = (): void => setReduced(computeReducedMotion());

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Safari < 14 only supports addListener / removeListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
    } else {
      mql.addListener(update);
    }

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      observer = new MutationObserver(update);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-cocoa-reduced-motion'],
      });
    }

    // Sync once on mount in case the attribute / MQ changed between
    // the initial render and effect commit.
    update();

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', update);
      } else {
        mql.removeListener(update);
      }
      observer?.disconnect();
    };
  }, []);

  return reduced;
}

function computeReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-cocoa-reduced-motion');
    if (attr !== null && attr !== 'false') return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}
