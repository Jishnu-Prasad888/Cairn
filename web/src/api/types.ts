/** Shared API types. Kept in one place so clients stay consistent. */

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'ok' | 'error';
}

export interface VersionResponse {
  version: string;
  commit: string;
  build_date: string;
  go_version: string;
  platform: string;
}
