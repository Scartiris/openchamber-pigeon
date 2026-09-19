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

import { cn } from '@/lib/utils';

export type SegmentedSliderOption<Value extends string> = {
  value: Value;
  label: string;
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
};

export function SegmentedSlider<Value extends string>(props: SegmentedSliderProps<Value>) {
  const { options, value, onChange, ariaLabel, className, stopClassName, thumbClassName } = props;
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
          'pointer-events-none absolute left-0.5 top-0.5 rounded-full bg-interactive-selection',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          stopClassName,
          thumbClassName,
        )}
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
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
              'relative z-10 rounded-full outline-none',
              'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
              option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
              stopClassName,
            )}
          >
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
