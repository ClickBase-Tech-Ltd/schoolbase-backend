import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const sourceConnectionString = process.env.DATABASE_URL;
if (!sourceConnectionString) throw new Error('DATABASE_URL is required to create a schema-only test clone.');

const sourceUrl = new URL(sourceConnectionString);
if (!['mysql:', 'mariadb:'].includes(sourceUrl.protocol)) throw new Error('The isolated attendance runner supports MySQL/MariaDB only.');

const sourceDatabase = decodeURIComponent(sourceUrl.pathname.replace(/^\//, ''));
if (!sourceDatabase || /prod(uction)?|live/i.test(sourceDatabase)) {
  throw new Error('Refusing to clone an empty or production-like database name.');
}

const disposableDatabase = `${sourceDatabase.slice(0, 24)}_staff_att_${randomBytes(5).toString('hex')}`;
if (disposableDatabase === sourceDatabase) throw new Error('Disposable database name must differ from the source database.');

const mysqlPassword = decodeURIComponent(sourceUrl.password);
const mysqlEnvironment = { ...process.env, MYSQL_PWD: mysqlPassword };
const mysqlArgs = [
  `--host=${sourceUrl.hostname}`,
  `--port=${sourceUrl.port || '3306'}`,
  `--user=${decodeURIComponent(sourceUrl.username)}`,
  '--default-character-set=utf8mb4',
];

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, {
    env: mysqlEnvironment,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  return result.stdout;
}

let databaseCreated = false;
try {
  run('mysql', [
    ...mysqlArgs,
    `--database=${sourceDatabase}`,
    `--execute=CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  ]);
  databaseCreated = true;

  const schemaDump = run('mysqldump', [
    ...mysqlArgs,
    '--no-data',
    '--skip-lock-tables',
    '--skip-comments',
    sourceDatabase,
  ]);
  run('mysql', [...mysqlArgs, `--database=${disposableDatabase}`], schemaDump);

  run('mysql', [
    ...mysqlArgs,
    `--database=${disposableDatabase}`,
    '--execute=DROP TABLE IF EXISTS `AttendanceStationEvent`; ALTER TABLE `StaffAttendanceEvent` DROP FOREIGN KEY `StaffAttendanceEvent_stationId_fkey`, DROP INDEX `staff_att_event_station_date_idx`, DROP COLUMN `stationId`; DROP TABLE IF EXISTS `AttendanceStation`;',
  ]);

  const stationMigrations = [
    resolve(process.cwd(), 'prisma/migrations/20261021_add_staff_attendance_stations/migration.sql'),
    resolve(process.cwd(), 'prisma/migrations/20261022_add_printable_station_code/migration.sql'),
  ];
  for (const migrationPath of stationMigrations) {
    const migrationSql = run('cat', [migrationPath]);
    run('mysql', [...mysqlArgs, `--database=${disposableDatabase}`], migrationSql);
  }

  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${disposableDatabase}`;
  const testRun = spawnSync('npm', ['run', 'test:staff-attendance:db'], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DATABASE_URL: testUrl.toString(), MYSQL_PWD: mysqlPassword },
    stdio: 'inherit',
  });
  if (testRun.error) throw testRun.error;
  if (testRun.status !== 0) throw new Error(`Staff attendance integration tests exited with status ${testRun.status}.`);
} finally {
  if (databaseCreated) {
    run('mysql', [
      ...mysqlArgs,
      `--database=${sourceDatabase}`,
      `--execute=DROP DATABASE \`${disposableDatabase}\``,
    ]);
  }
}