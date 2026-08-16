import { Pool, type QueryResultRow } from "pg";
import { SCHEMA_SQL } from "./schema";

/**
 * One pool per process. Neon pools over its own pgbouncer endpoint, so the
 * pool here stays small: serverless functions are many and short-lived.
 */
let pool: Pool | null = null;

export const db = (): Pool => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Number(process.env.VERIT_DB_POOL_MAX) || 5,
      ssl: /\bsslmode=require\b/.test(connectionString) ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
};

export const query = async <T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> => (await db().query<T>(sql, params as unknown[])).rows;

export const migrate = async (): Promise<void> => {
  await db().query(SCHEMA_SQL);
};
