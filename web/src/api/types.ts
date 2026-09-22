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

export interface Library {
  id: string;
  name: string;
  path: string;
}

export type RefType = 'media' | 'memory' | 'album' | 'person' | 'tag';

export interface Memory {
  id: string;
  title: string;
  body: string;
  memory_date?: string;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemoryVersion {
  memory_id: string;
  version: number;
  title: string;
  body: string;
  saved_at: string;
}

export interface MemoryRef {
  type: RefType;
  id: string;
}

export interface MemoryListResponse {
  memories: Memory[];
  next_cursor?: string;
}

export interface MemoryCreateRequest {
  title: string;
  body: string;
  memory_date?: string;
}

export interface MemoryUpdateRequest {
  title: string;
  body: string;
  memory_date?: string;
}
