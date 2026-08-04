import type { SyncableTable } from '@medguard/shared';
import type { ApiResult } from './householdApi.js';
import { request } from './householdApi.js';

/** The sync surface — bootstrap, cursor-based pull, batched push. See apps/api/src/routes/sync.ts. */

export interface SyncRecordDTO {
  table: SyncableTable;
  id: string;
  seq: number;
  payload: unknown;
}

export interface PullResponse {
  cursor: number;
  records: SyncRecordDTO[];
  /** Absent on a bootstrap response — a fresh snapshot has nothing left to page through. */
  hasMore?: boolean;
}

export interface PushChange {
  table: SyncableTable;
  record: unknown;
}

export interface PushBlockedItem {
  table: string;
  id: string;
  reason?: string;
  availableAtIso?: string;
  msRemaining?: number;
}

export interface PushResponse {
  cursor: number;
  results: { table: string; id: string; outcome: string }[];
  blocked: PushBlockedItem[];
  rejected: { table: string; id: string | null; issues: unknown }[];
}

export function bootstrap(apiBaseUrl: string, token: string): Promise<ApiResult<PullResponse>> {
  return request('GET', `${apiBaseUrl}/api/v1/sync/bootstrap`, { token });
}

export function pull(apiBaseUrl: string, token: string, cursor: number): Promise<ApiResult<PullResponse>> {
  return request('GET', `${apiBaseUrl}/api/v1/sync/pull?cursor=${cursor}`, { token });
}

export function pushChanges(
  apiBaseUrl: string,
  token: string,
  changes: PushChange[],
): Promise<ApiResult<PushResponse>> {
  return request('POST', `${apiBaseUrl}/api/v1/sync/push`, { token, body: { changes } });
}
