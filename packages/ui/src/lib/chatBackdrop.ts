/**
 * Pigeon: the video backdrop behind the whole workspace.
 *
 * The feature is inert until the user turns it on: the surfaces it touches fall
 * back to the plain fill they had before, so an install that never enables it
 * renders exactly like upstream.
 *
 * Three knobs, deliberately distinct:
 * - `intensity` — how much of the footage itself survives (`opacity` on the
 *   media element). 100 keeps the wallpaper at full strength.
 * - `scrim` — a theme-tinted veil mixed *toward* `--background` that buys back
 *   text contrast. The light theme adds a small fixed boost in CSS (see
 *   `design-system.css`), which is why the stored maximum stays below 100%.
 * - `surfaceOpacity` — how solid the panes that hold text are. This is the knob
 *   that decides how much "atmosphere" reaches the reader; the panels cover the
 *   whole window, so it dominates the look far more than the other two.
 */

export const CHAT_BACKDROP_VIDEO_SRC = '/ambient/chat-backdrop.mp4';
export const CHAT_BACKDROP_POSTER_SRC = '/ambient/chat-backdrop.poster.jpg';

export const CHAT_BACKDROP_INTENSITY_MIN = 0;
export const CHAT_BACKDROP_INTENSITY_MAX = 100;
export const CHAT_BACKDROP_INTENSITY_DEFAULT = 100;

/** Capped at 92: the light-theme boost in CSS adds up to 8 percentage points. */
export const CHAT_BACKDROP_SCRIM_MIN = 0;
export const CHAT_BACKDROP_SCRIM_MAX = 92;
export const CHAT_BACKDROP_SCRIM_DEFAULT = 30;

/**
 * Panel fill. 100 = opaque panes (upstream look), lower = more wallpaper.
 * 62% keeps body text comfortable over a busy frame; the slider goes to 25 so
 * the atmosphere can be pushed hard when the theme and the footage allow it.
 */
export const CHAT_BACKDROP_SURFACE_MIN = 25;
export const CHAT_BACKDROP_SURFACE_MAX = 100;
export const CHAT_BACKDROP_SURFACE_DEFAULT = 62;

export const CHAT_BACKDROP_MOTION_DEFAULT = true;

export const clampChatBackdropIntensity = (value: number): number =>
  Math.min(CHAT_BACKDROP_INTENSITY_MAX, Math.max(CHAT_BACKDROP_INTENSITY_MIN, Math.round(value)));

export const clampChatBackdropScrim = (value: number): number =>
  Math.min(CHAT_BACKDROP_SCRIM_MAX, Math.max(CHAT_BACKDROP_SCRIM_MIN, Math.round(value)));

export const clampChatBackdropSurface = (value: number): number =>
  Math.min(CHAT_BACKDROP_SURFACE_MAX, Math.max(CHAT_BACKDROP_SURFACE_MIN, Math.round(value)));
