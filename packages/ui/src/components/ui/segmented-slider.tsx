/**
 * A compact segmented slider: one small track, one thumb, N stops.
 *
 * It exists for controls that are a *choice between a few named options* rather
 * than a boolean — the composer's mode switch (施工 / 计划 / 聊天) — where a row of
 * chips costs too much footer width and a checkbox would not say "one of three".
 *
 * The track is small on purpose: the label that names the current option lives
 * next to it in the caller, so the control itself only has to show *where* the
 * choice sits.
 *
 * Each stop can carry a small icon. That is what makes an *uncovered* position
 * legible: the thumb only ever marks where the choice is, so without a glyph the
 * other positions are blank track and the control says nothing about them. The
 * icon of the covered position is drawn on the thumb in the selection foreground;
 * the uncovered ones stay muted, so "where am I" and "what else is there" are one
 * glance apart.
 *
 * Geometry is measured, not assumed. The thumb is drawn *behind* one stop at a
 * time, so it takes that stop's width and offset — which is why the caller gives
 * `stopClassName` (how wide one stop is) instead of a thumb size. A thumb sized
 * independently of the stops overflows the track as soon as the two disagree, and
 * an overflowed thumb sits on top of the neighbouring control. Every stop is a real
 * button with a real hit area, so the whole control is clickable, keyboard
 * reachable and screen-reader reachable; the selected stop carries `aria-pressed`,
 * and stops that cannot be chosen stay visible with `aria-disabled` (hiding them
 * would read as "this mode is gone").
 *
 * Geometry uses translate only (see the animation contract): the thumb moves by
 * `index * 100%` of its own width.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

export type SegmentedSliderOption<Value extends string> = {
  value: Value;
  label: string;
  /** Small glyph drawn inside the stop. Without it the stop is blank track. */
  icon?: IconName;
  disabled?: boolean;
};

type SegmentedSliderProps<Value extends string> = {
  options: readonly SegmentedSliderOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  /** Size of the track, i.e. of the strip around the stops. */
  className?: string;
  /** Size of ONE stop. The thumb copies it, so the two can never disagree. */
  stopClassName: string;
  /** Extra classes for the thumb, e.g. an inset ring. Size comes from the stop. */
  thumbClassName?: string;
  /** Size of a stop's icon. Defaults to a glyph that fits a ~14px stop. */
  iconClassName?: string;
};

export function SegmentedSlider<Value extends string>(props: SegmentedSliderProps<Value>) {
  const { options, value, onChange, ariaLabel, className, stopClassName, thumbClassName, iconClassName } = props;
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border border-border/60 p-0.5',
        className,
      )}
    >
      {/* Behind the stops and not interactive: the stops are. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0.5 top-1/2 rounded-full bg-interactive-selection',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          stopClassName,
          thumbClassName,
        )}
        // `-translate-y-1/2` centres the thumb on the track's own axis instead of
        // pinning it to the padding edge. The stops are flex-centred on the same
        // line, so the two agree whatever height the caller gives a stop — a
        // pinned `top` only matched while the stop happened to fit the content
        // box, and was 1px off the moment it did not (which put the stop's icon
        // visibly off-centre in the thumb). The X percentage is of the thumb's
        // own width, so the horizontal step is unaffected.
        style={{ transform: `translate(${activeIndex * 100}%, -50%)` }}
      />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-disabled={option.disabled || undefined}
            title={option.label}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            className={cn(
              'relative z-10 inline-flex items-center justify-center rounded-full outline-none',
              'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
              option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
              stopClassName,
            )}
          >
            {option.icon ? (
              <Icon
                name={option.icon}
                className={cn(
                  iconClassName ?? 'h-2.5 w-2.5',
                  // The covered stop's glyph sits on the thumb, so it takes the
                  // selection foreground; the others stay muted on the track.
                  selected ? 'text-interactive-selection-foreground' : 'text-muted-foreground',
                )}
              />
            ) : null}
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
