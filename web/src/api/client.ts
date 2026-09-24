/**
 * API client for Cairn's JSON API v1.
 *
 * The frontend is deliberately a pure client of the backend HTTP API. Every
 * request goes through this module, which understands the API error envelope
 * and turns failures into typed {@link ApiError} objects.
 */

export const API_BASE = '/api/v1';

/** Error envelope returned by the server. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

/** Thrown for any non-2xx API response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requestId = body.request_id;
    this.details = body.details;
  }
}

/** A typed JSON request against the API. */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: HeadersInit = { Accept: 'application/json' };
  let body: BodyInit | null = null;
  if (init?.body !== undefined && init.body !== null) {
    headers['Content-Type'] = 'application/json';
    body = init.body;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
    body,
  });

  if (!response.ok) {
    const body = await readErrorEnvelope(response);
    throw new ApiError(body, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function readErrorEnvelope(response: Response): Promise<ApiErrorBody> {
  try {
    const envelope = (await response.json()) as ApiErrorEnvelope;
    if (envelope?.error?.code) {
      return envelope.error;
    }
  } catch {
    // fall through to the fallback below
  }
  return {
    code: 'UNKNOWN',
    message: `Request failed with status ${response.status}.`,
    request_id: '',
  };
}

export const apiGet = <T>(path: string) => apiRequest<T>(path);

const withJsonBody = (method: string, body: unknown): RequestInit =>
  body === undefined ? { method } : { method, body: JSON.stringify(body) };

export const apiPost = <T>(path: string, body?: unknown) =>
  apiRequest<T>(path, withJsonBody('POST', body));
export const apiPatch = <T>(path: string, body?: unknown) =>
  apiRequest<T>(path, withJsonBody('PATCH', body));
export const apiPut = <T>(path: string, body?: unknown) =>
  apiRequest<T>(path, withJsonBody('PUT', body));
export const apiDelete = <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' });

/** Multipart upload. The browser sets the multipart boundary, so no
 * Content-Type header is sent here. `path` is the destination relative path
 * (falls back to the file name server-side). */
export async function apiUpload<T>(endpoint: string, file: File, path?: string): Promise<T> {
  const form = new FormData();
  if (path) form.append('path', path);
  form.append('file', file);

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    body: form,
  });

  if (!response.ok) {
    const body = await readErrorEnvelope(response);
    throw new ApiError(body, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
