/**
 * Arena rules and fees, imported from the same config files the engine enforces (SPEC §3), validated with zod.
 */
import { arenaConfigSchema, feesConfigSchema } from '@arena/shared/schemas';
import arenaJson from '../../../../config/arena.json';
import feesJson from '../../../../config/fees.json';

export const arena = arenaConfigSchema.parse(arenaJson);
export const fees = feesConfigSchema.parse(feesJson);

export function siteMode(): 'shadow' | 'live' {
  return process.env.ARENA_MODE === 'live' ? 'live' : 'shadow';
}

export const SOURCE_URL =
  process.env.NEXT_PUBLIC_SOURCE_URL ?? 'https://github.com/AyushChangedia/ai-arena';
