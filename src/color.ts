/** Accept a pasted CSS HEX color, including its three-digit shorthand. */
export function normalizeHex(value: string): string | null {
  const digits = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(digits)) return '#' + [...digits].map(digit => digit + digit).join('');
  return /^[0-9a-f]{6}$/.test(digits) ? '#' + digits : null;
}
