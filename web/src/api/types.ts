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

export interface FaceStatus {
  enabled: boolean;
  provider: string;
  provider_version: number;
  faces: number;
  people: number;
  unassigned: number;
}

export interface Person {
  id: string;
  name: string;
  cover_face_id?: string;
  cover_file_id?: string;
  face_count: number;
  created_at: string;
  updated_at: string;
}

export interface FaceSummary {
  id: string;
  file_id: string;
  file_path?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface FileSummary {
  id: string;
  library_id: string;
  rel_path: string;
  name: string;
  folder_path: string;
  size_bytes: number;
  mod_time: string;
  media_type: string;
  mime_type: string;
  status: string;
  content_hash?: string;
}

export interface DuplicateGroup {
  content_hash: string;
  size_bytes: number;
  files: FileSummary[];
}

export interface DuplicatesResponse {
  groups: DuplicateGroup[];
  next_cursor?: string;
  total: number;
}

export interface Folder {
  id: string;
  library_id?: string;
  rel_path: string;
  parent_id?: string;
  name: string;
  file_count: number;
}

export interface FolderListResponse {
  folders: Folder[];
}

export interface FileListResponse {
  files: FileSummary[];
  next_cursor?: string;
  total: number;
}

export interface Album {
  id: string;
  name: string;
  description?: string;
  cover_file_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AlbumListResponse {
  albums: Album[];
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  created_at: string;
}

export interface TagListResponse {
  tags: Tag[];
}

export interface TagEnvelope {
  tag: Tag;
}

export interface FileCollectionResponse {
  files: FileSummary[];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
