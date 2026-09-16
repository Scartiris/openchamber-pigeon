const asString = (value) => (value === null || value === undefined ? null : String(value));

const asNonEmptyString = (value) => {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asObject = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return null;
  if (Object.prototype.toString.call(value) !== '[object Object]') return null;
  return value;
};

const asFiniteNumber = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const asBoolean = (value, fallback = false) => {
  if (value === true || value === false) return value;
  return fallback;
};

export { asString, asNonEmptyString, asObject, asFiniteNumber, asBoolean };
