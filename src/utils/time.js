const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parses simple "15m" / "7d" style strings (as used in JWT expiresIn env
 * vars) into milliseconds, for use as cookie maxAge.
 */
export function parseExpiryToMs(expiresIn) {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) return 15 * 60 * 1000;
  const value = Number(match[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: MS_PER_DAY }[match[2]];
  return value * unit;
}
