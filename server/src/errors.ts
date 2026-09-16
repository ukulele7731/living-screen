// Ошибки API с понятным русским текстом (раздел 6: «всё с понятными русскими ошибками»).

export class ApiError extends Error {
  constructor(readonly statusCode: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const unauthorized = (m = 'Нужно войти') => new ApiError(401, m);
export const forbidden = (m = 'Недостаточно прав') => new ApiError(403, m);
export const notFound = (m = 'Не найдено') => new ApiError(404, m);
export const tooMany = (m: string, retryAfterSec: number) => new ApiError(429, m, { retryAfterSec });
