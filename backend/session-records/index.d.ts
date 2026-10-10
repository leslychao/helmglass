import type { DatabaseSync } from "node:sqlite";

export function initializeRecords(db: DatabaseSync): void;
export function openRecords(filename: string): DatabaseSync;
export function operationReceipt(db: DatabaseSync, id: string, stopped?: boolean):
  ({ operationId: string; status: string } & Record<string, unknown>) | undefined;
export function artifactPage(db: DatabaseSync, after?: number):
  { artifacts: Record<string, unknown>[]; nextCursor: number; hasMore: boolean };
