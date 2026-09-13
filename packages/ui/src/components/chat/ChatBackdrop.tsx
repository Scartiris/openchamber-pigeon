/**
 * Pigeon: the video backdrop layer for the chat column.
 *
 * Mount it as the first child of a `relative isolate` chat surface; it paints
 * at `z-index: -1`, i.e. above that surface's own background and below all of
 * its content. The parent is responsible for the `oc-chat-backdrop-on` class
 * and the two CSS variables returned by `useChatBackdrop`.
 */
import React from 'react';

import {
  CHAT_BACKDROP_POSTER_SRC,
  CHAT_BACKDROP_VIDEO_SRC,
  clampChatBackdropIntensity,
  clampChatBackdropScrim,
  clampChatBackdropSurface,
} from '@/lib/chatBackdrop';
import { useUIStore } from '@/stores/useUIStore';

/** The light theme buys back a few extra points of veil; see `design-system.css`. */
const LIGHT_SCRIM_BOOST = 8;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = React.useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false
  ));

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
};

export type ChatBackdropState = {
  /** Whether the media layer should render at all. */
  enabled: boolean;
  /** Breathing animation requested by the user (media queries still win). */
  motion: boolean;
  /** Class for the element that wraps both the layer and the surfaces. */
  rootClassName: string;
  /** The variables the surfaces and the scrim read. */
  style: React.CSSProperties;
};

export const useChatBackdrop = (): ChatBackdropState => {
  const enabled = useUIStore((state) => state.chatBackdropEnabled);
  const intensity = useUIStore((state) => state.chatBackdropIntensity);
  const scrim = useUIStore((state) => state.chatBackdropScrim);
  const surfaceOpacity = useUIStore((state) => state.chatBackdropSurfaceOpacity);
  const motion = useUIStore((state) => state.chatBackdropMotion);

  return React.useMemo(() => {
    const safeIntensity = clampChatBackdropIntensity(intensity);
    const safeScrim = clampChatBackdropScrim(scrim);
    const safeSurface = clampChatBackdropSurface(surfaceOpacity);
    return {
      enabled,
      motion,
      rootClassName: enabled ? 'oc-chat-backdrop-on' : '',
      style: {
        '--oc-chat-backdrop-intensity': String(safeIntensity / 100),
        '--oc-chat-scrim-opacity': `${safeScrim}%`,
        '--oc-chat-scrim-opacity-light': `${Math.min(100, safeScrim + LIGHT_SCRIM_BOOST)}%`,
        '--oc-surface-opacity': `${safeSurface}%`,
      } as React.CSSProperties,
    };
  }, [enabled, intensity, motion, scrim, surfaceOpacity]);
};

type ChatBackdropProps = {
  motion: boolean;
};

export const ChatBackdrop = React.memo(({ motion }: ChatBackdropProps) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // The transcript is often in a background tab; a looping 1080p decode there
    // is pure battery burn.
    const syncPlayback = () => {
      if (document.hidden) {
        video.pause();
        return;
      }
      void video.play().catch(() => {
        // Autoplay refusal (or a decode failure) leaves the poster frame in
        // place, which is a perfectly good static backdrop.
      });
    };

    syncPlayback();
    document.addEventListener('visibilitychange', syncPlayback);
    return () => {
      document.removeEventListener('visibilitychange', syncPlayback);
      video.pause();
    };
  }, [reducedMotion]);

  return (
    <div className="oc-chat-backdrop" aria-hidden="true">
      {reducedMotion ? (
        <img
          className="oc-chat-backdrop-media"
          src={CHAT_BACKDROP_POSTER_SRC}
          alt=""
          draggable={false}
        />
      ) : (
        <video
          ref={videoRef}
          className={motion ? 'oc-chat-backdrop-media oc-chat-backdrop-motion' : 'oc-chat-backdrop-media'}
          src={CHAT_BACKDROP_VIDEO_SRC}
          poster={CHAT_BACKDROP_POSTER_SRC}
          muted
          loop
          playsInline
          // Declarative so a remount while the OS reduced-motion setting flips
          // starts playing again; the effect above only owns visibility.
          autoPlay
          preload="auto"
          disablePictureInPicture
        />
      )}
      <div className="oc-chat-scrim" />
      <div className="oc-chat-scrim-vignette" />
    </div>
  );
});

ChatBackdrop.displayName = 'ChatBackdrop';
