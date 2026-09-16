// Коды и токены (раздел 3 server-spec.md). Алфавит без похожих символов: нет 0/O, 1/I.
// Код комнаты: префикс сезона + 4 символа (~1 млн на сезон), при исчерпании — 5 символов.
// Пароль владельца: 6 символов из того же алфавита. Код привязки экрана: 4 цифры.
import crypto from 'node:crypto';

export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 символа

export const SEASON_PREFIX: Record<string, string> = { autumn: 'LEAF', winter: 'SNOW' };
export const SEASONS = Object.keys(SEASON_PREFIX);

export function randomFrom(alphabet: string, length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function roomCode(season: string, length = 4): string {
  const prefix = SEASON_PREFIX[season];
  if (!prefix) throw new Error(`неизвестный сезон ${season}`);
  return `${prefix}-${randomFrom(ALPHABET, length)}`;
}

/** Нормализация кода, введённого руками: регистр, похожие символы, дефис. */
export function normalizeRoomCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z]{4})([A-Z0-9]{4,5})$/.exec(s);
  if (!m) return null;
  const tail = m[2].replace(/0/g, 'O').replace(/1/g, 'I');   // O/0 и I/1 читаются одинаково — в алфавите их нет, но ввести могли
  if (![...tail].every((c) => ALPHABET.includes(c))) return null;
  if (!Object.values(SEASON_PREFIX).includes(m[1])) return null;
  return `${m[1]}-${tail}`;
}

export function ownerPassword(): string { return randomFrom(ALPHABET, 6); }

export function normalizePassword(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
}

export function pairingCode(): string { return randomFrom('0123456789', 4); }

/** Секретный токен роли (владелец, экран, гость): 192 бита, base64url. */
export function token(): string { return crypto.randomBytes(24).toString('base64url'); }

/** Хеш токена для базы: токен случайный и длинный, sha256 достаточно. */
export function tokenHash(t: string): string { return crypto.createHash('sha256').update(t).digest('hex'); }

/** Пароль короткий — scrypt с солью. Формат: scrypt$<соль>$<хеш>. */
export function passwordHash(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalizePassword(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(normalizePassword(password), Buffer.from(saltB64, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
