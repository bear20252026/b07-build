import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ComponentManagementReceiptStore, ComponentManagementReceiptV1 } from '../../component-management.js';

interface ReceiptRow { receipt_json: string; }

function copyReceipt(receipt: ComponentManagementReceiptV1): ComponentManagementReceiptV1 {
  return { ...receipt };
}

/** SQLite WAL append-only 本地宿主构件管理回执账本；不保存制品、来源 URL、路径、命令或凭据。 */
export class SqliteComponentManagementReceiptStore implements ComponentManagementReceiptStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS component_management_receipts (
        operation_id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS component_management_receipts_component_idx
        ON component_management_receipts(component_id, recorded_at_ms DESC, operation_id ASC);
    `);
  }

  load(operationId: string): ComponentManagementReceiptV1 | undefined {
    const row = this.db.prepare(`
      SELECT receipt_json FROM component_management_receipts WHERE operation_id = ?
    `).get(operationId) as ReceiptRow | undefined;
    return row ? copyReceipt(JSON.parse(row.receipt_json) as ComponentManagementReceiptV1) : undefined;
  }

  append(receipt: ComponentManagementReceiptV1): void {
    this.db.prepare(`
      INSERT INTO component_management_receipts(operation_id, component_id, action, outcome, recorded_at_ms, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receipt.operationId, receipt.componentId, receipt.action, receipt.outcome, receipt.recordedAt, JSON.stringify(copyReceipt(receipt)));
  }

  list(componentId?: string): readonly ComponentManagementReceiptV1[] {
    const rows = (componentId === undefined
      ? this.db.prepare(`SELECT receipt_json FROM component_management_receipts ORDER BY recorded_at_ms DESC, operation_id ASC`).all()
      : this.db.prepare(`SELECT receipt_json FROM component_management_receipts WHERE component_id = ? ORDER BY recorded_at_ms DESC, operation_id ASC`).all(componentId)
    ) as unknown as readonly ReceiptRow[];
    return rows.map((row) => copyReceipt(JSON.parse(row.receipt_json) as ComponentManagementReceiptV1));
  }

  close(): void {
    this.db.close();
  }
}
