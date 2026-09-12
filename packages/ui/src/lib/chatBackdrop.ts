/**
 * Pigeon: the video backdrop behind the chat column.
 *
 * The feature is inert until the user turns it on: the surfaces it touches fall
 * back to the plain `--background` fill they had before, so an install that
 * never enables it renders exactly like upstream.
 *
 * Two knobs, deliberately distinct:
 * - `intensity` — how much of the footage itself survives (`opacity` on the
 *   media element). 100 keeps the wallpaper at full strength.
 * - `scrim` — a theme-tinted veil mixed *toward* `--background` that buys back
 *   text contrast. The light theme gets a fixed extra boost in CSS (see
 *   `design-system.css`), which is why the stored maximum stays below 100%.
 */

export const CHAT_BACKDROP_VIDEO_SRC = '/ambient/chat-backdrop.mp4';
export const CHAT_BACKDROP_POSTER_SRC = '/ambient/chat-backdrop.poster.jpg';

export const CHAT_BACKDROP_INTENSITY_MIN = 0;
export const CHAT_BACKDROP_INTENSITY_MAX = 100;
export const CHAT_BACKDROP_INTENSITY_DEFAULT = 70;

/** Capped at 80: the light-theme boost in CSS adds up to 20 percentage points. */
export const CHAT_BACKDROP_SCRIM_MIN = 0;
export const CHAT_BACKDROP_SCRIM_MAX = 80;
export const CHAT_BACKDROP_SCRIM_DEFAULT = 45;

export const CHAT_BACKDROP_MOTION_DEFAULT = true;

export const clampChatBackdropIntensity = (value: number): number =>
  Math.min(CHAT_BACKDROP_INTENSITY_MAX, Math.max(CHAT_BACKDROP_INTENSITY_MIN, Math.round(value)));

export const clampChatBackdropScrim = (value: number): number =>
  Math.min(CHAT_BACKDROP_SCRIM_MAX, Math.max(CHAT_BACKDROP_SCRIM_MIN, Math.round(value)));
