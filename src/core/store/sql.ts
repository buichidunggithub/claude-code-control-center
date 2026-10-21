import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

export type Row = Readonly<Record<string, SQLOutputValue>>;

export function all(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function one(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

export function run(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

// Column readers throw on a type mismatch without echoing the value (it may be sensitive).
export function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`column ${key} is not an integer`);
}

export function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  throw new TypeError(`column ${key} is not text`);
}

export function optNum(row: Row, key: string): number | null {
  return row[key] === null ? null : num(row, key);
}

export function optStr(row: Row, key: string): string | null {
  return row[key] === null ? null : str(row, key);
}

export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Reduces a database error to a stable code. The message is dropped because it may quote data. */
export function sqliteErrorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "errcode" in error && typeof error.errcode === "number") {
    return `SQLITE_${error.errcode}`;
  }
  return fallback;
}
