// Defensive array coercion for API responses.
//
// Backend endpoints sometimes return a raw array, sometimes an envelope object
// like { items: [...] }, { data: [...] }, etc. This helper normalizes both
// shapes to a real array so downstream `.filter`, `.map`, `.find` calls
// cannot crash with 'X is not a function'.
//
// Usage:
//   const rows = useMemo(() => toArray<SubmissionRow>(data), [data]);
//
// Recognizes common envelope keys: items, data, results, submissions, list,
// records, rows. Falls back to [] if nothing matches.

const ENVELOPE_KEYS = ['items', 'data', 'results', 'submissions', 'list', 'records', 'rows'] as const;

export function toArray<T>(input: unknown): T[] {
  if (Array.isArray(input)) return input as T[];
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ENVELOPE_KEYS) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}
