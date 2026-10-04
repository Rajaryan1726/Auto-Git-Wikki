import { apiErrorSchema } from '@autowiki/shared';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

/** Fetch wrapper: sends cookies, encodes JSON bodies, and normalises error responses. */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    if (parsed.success) {
      throw new ApiRequestError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        data,
      );
    }
    throw new ApiRequestError(res.status, 'HTTP_ERROR', `Request failed with ${res.status}`, data);
  }

  return data as T;
}
