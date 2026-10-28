import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

/**
 * Base PostGIS real para las pruebas de integración.
 * - Si TEST_DATABASE_URL está definida, se usa esa base (debe ser descartable).
 * - Si no, se levanta un contenedor postgis/postgis:17-3.5 con Testcontainers.
 */
let container: StartedTestContainer | null = null;

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new GenericContainer('postgis/postgis:17-3.5')
      .withEnvironment({ POSTGRES_USER: 'geo', POSTGRES_PASSWORD: 'geo', POSTGRES_DB: 'geo_test' })
      .withExposedPorts(5432)
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    url = `postgres://geo:geo@${container.getHost()}:${container.getMappedPort(5432)}/geo_test`;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  await migrate(pool);
  await pool.end();
  project.provide('dbUrl', url);
  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}
