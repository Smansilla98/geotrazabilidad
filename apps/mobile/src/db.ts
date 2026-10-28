import * as SQLite from 'expo-sqlite';
import { SqliteQueueStore, type SqlDriver } from '@geo/shared';

/**
 * Cola local persistente sobre expo-sqlite. El SQL y la lógica de la cola son los de
 * @geo/shared (probados con SQLite real); aquí solo se adapta el driver.
 * Se abre de forma perezosa: la tarea de segundo plano puede correr en un contexto JS nuevo.
 */
let store: Promise<SqliteQueueStore> | null = null;

function driver(db: SQLite.SQLiteDatabase): SqlDriver {
  let depth = 0;
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => void (await db.runAsync(sql, params as SQLite.SQLiteBindParams)),
    all: <T>(sql: string, params: unknown[] = []) => db.getAllAsync<T>(sql, params as SQLite.SQLiteBindParams),
    // Transacciones anidadas se aplanan (la cola no las anida, pero se protege).
    transaction: async (fn) => {
      if (depth > 0) return fn();
      depth++;
      try {
        let result!: Awaited<ReturnType<typeof fn>>;
        await db.withTransactionAsync(async () => {
          result = await fn();
        });
        return result;
      } finally {
        depth--;
      }
    },
  };
}

export function getStore(): Promise<SqliteQueueStore> {
  store ??= (async () => {
    const db = await SQLite.openDatabaseAsync('geo-queue.db');
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const s = new SqliteQueueStore(driver(db));
    await s.migrate();
    return s;
  })();
  return store;
}
