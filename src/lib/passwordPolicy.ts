export const MIN_PASSWORD_LENGTH = 12;

export function passwordError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || [...value].length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов.`;
  }
  // Compatible with existing bcrypt-backed GoTrue installations; never trim passwords.
  if (new TextEncoder().encode(value).length > 72) {
    return 'Пароль слишком длинный: максимум 72 байта UTF-8 (кириллица занимает больше одного байта).';
  }
  return null;
}
