const INJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'ignore_previous_instructions', pattern: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i },
  { label: 'ignore_above', pattern: /ignore\s+the\s+above/i },
  { label: 'disregard_instructions', pattern: /disregard\s+(the\s+)?(system|previous|prior|above)/i },
  { label: 'reveal_system_prompt', pattern: /reveal\s+(the\s+)?(system\s+prompt|instructions)/i },
  { label: 'role_marker', pattern: /<\|im_start\|>|<\|im_end\|>|<\|system\|>/i },
  { label: 'role_reassignment', pattern: /you\s+are\s+now\s+(a|an|the)\s+/i },
  { label: 'do_not_follow', pattern: /do\s+not\s+(follow|obey)\s+(the\s+)?(instructions|review|rules)/i },
];

const UNSAFE_CONTROL_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export interface SanitizedText {
  text: string;
  removed: number;
}

export function sanitizeUnsafeCharacters(text: string): SanitizedText {
  let removed = 0;
  const cleaned = text.replace(UNSAFE_CONTROL_PATTERN, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
}

export function detectInjectionSuspicion(text: string): string[] {
  const hits = new Set<string>();
  for (const entry of INJECTION_PATTERNS) {
    if (entry.pattern.test(text)) hits.add(entry.label);
  }
  if (sanitizeUnsafeCharacters(text).removed > 0) {
    hits.add('bidi_or_zero_width_characters');
  }
  return [...hits];
}
