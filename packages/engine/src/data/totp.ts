import { TOTP, Secret } from 'otpauth';

/** 6-digit SHA-1 TOTP with a 30 s period, generated at call time. */
export function totpNow(base32Secret: string, at: number = Date.now()): string {
  const totp = new TOTP({
    secret: Secret.fromBase32(base32Secret.replace(/\s+/g, '').toUpperCase()),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return totp.generate({ timestamp: at });
}

/** Milliseconds until the next 30-second TOTP window starts. */
export function msUntilNextTotpWindow(at: number = Date.now()): number {
  return 30_000 - (at % 30_000);
}
