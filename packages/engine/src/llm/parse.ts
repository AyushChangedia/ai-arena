/** Reading a model's answer (SPEC §9.3). Store the raw content regardless of the outcome. */

export interface ParsedDecision {
  reasoning: string;
  actions: unknown[];
  noteToSelf: string;
  flags: string[];
  method: 'whole' | 'fenced' | 'braces';
}

export type ParseResult = { ok: true; decision: ParsedDecision } | { ok: false; error: string };

/** The first balanced top-level {…} object, respecting strings and escapes. */
export function firstBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    // Not JSON: the caller tries the next strategy.
    return undefined;
  }
}

export function parseDecisionContent(
  content: string | null | undefined,
  opts: { noteMaxChars: number } = { noteMaxChars: 500 },
): ParseResult {
  if (content === null || content === undefined || content.trim() === '')
    return { ok: false, error: 'the reply was empty' };
  const text = content.trim();
  let value: unknown;
  let method: ParsedDecision['method'] = 'whole';
  value = tryJson(text);
  if (value === undefined) {
    const fences = [...text.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)];
    if (fences.length === 1) {
      value = tryJson(fences[0]![1]!.trim());
      method = 'fenced';
    }
  }
  if (value === undefined) {
    const obj = firstBalancedObject(text);
    if (obj) {
      value = tryJson(obj);
      method = 'braces';
    }
  }
  if (value === undefined)
    return { ok: false, error: 'no JSON object could be read from the reply' };
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'the reply is JSON but not an object' };
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.actions)) return { ok: false, error: 'the object has no "actions" array' };
  const flags: string[] = [];
  let reasoning = '';
  if (typeof o.reasoning === 'string') reasoning = o.reasoning;
  else flags.push('missing_reasoning');
  let noteToSelf = '';
  if (typeof o.note_to_self === 'string') noteToSelf = o.note_to_self;
  else flags.push('missing_note_to_self');
  if ([...noteToSelf].length > opts.noteMaxChars) {
    noteToSelf = [...noteToSelf].slice(0, opts.noteMaxChars).join('');
    flags.push('note_truncated');
  }
  return { ok: true, decision: { reasoning, actions: o.actions, noteToSelf, flags, method } };
}
