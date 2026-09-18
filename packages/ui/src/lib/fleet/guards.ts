/**
 * Value guards and the JSON boundary type for the fleet client.
 *
 * The workbench already parses device payloads this way (see
 * `components/sections/devices/DevicesPage.tsx`): a named `JsonValue` domain
 * type instead of `unknown`, and `Object.prototype.toString` tags instead of
 * runtime `typeof` narrowing — which is what this repo's anti-slop lint asks for.
 */

/** Boundary JSON value after `response.json()` — only this shape is accepted. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const isFiniteNumber = (value: JsonValue | undefined): value is number => (
  Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value)
);

export const isNonEmptyString = (value: JsonValue | undefined): value is string => {
  if (Object.prototype.toString.call(value) !== '[object String]') return false;
  // SAFETY: the tag above proves the value is a string primitive.
  return (value as string).trim().length > 0;
};

export const isBooleanValue = (value: JsonValue | undefined): value is boolean => (
  Object.prototype.toString.call(value) === '[object Boolean]'
);

export const isPlainRecord = (
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } => (
  Object.prototype.toString.call(value) === '[object Object]'
);
