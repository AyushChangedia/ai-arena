import { describe, it, expect, vi } from 'vitest';
import { main } from '../../src/cli';

describe('CLI entry point', () => {
  it('prints usage, rejects unknown commands, and maps config errors to exit 78', async () => {
    const out: string[] = [];
    const o = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => (out.push(String(s)), true));
    const e = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((s) => (out.push(String(s)), true));
    try {
      expect(await main([])).toBe(0);
      expect(out.join('')).toContain('Usage: pnpm engine <command>');
      expect(await main(['no-such-command'])).toBe(2);
      const saved = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      process.env.ARENA_CONFIG_DIR = '/nonexistent-config-dir';
      expect(await main(['decide', '--dry'])).toBe(78);
      delete process.env.ARENA_CONFIG_DIR;
      if (saved) process.env.OPENROUTER_API_KEY = saved;
      expect(out.join('')).toMatch(/Configuration problem: arena.json is missing/);
      expect(await main(['verify-ledger', '--file', '/nonexistent/ledger.jsonl'])).toBe(1);
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  });
});
