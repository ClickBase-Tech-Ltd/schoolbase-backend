import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '..');
const prismaSchemaPath = join(repoRoot, 'backend', 'prisma', 'schema.prisma');
const snapshotDir = repoRoot;

function readPrismaModels(schemaText: string): Set<string> {
  const modelMatches = [...schemaText.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gm)];
  return new Set(modelMatches.map((match) => match[1]));
}

function readSqlSnapshotModels(sqlText: string): Set<string> {
  const tableMatches = [...sqlText.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`|\")?([A-Za-z0-9_]+)(?:`|\")?/gi)];
  return new Set(tableMatches.map((match) => match[1]));
}

function findSnapshotSqlFile(): string {
  const entries = readdirSync(snapshotDir);
  const match = entries.find((entry) => /^schoolbase-database-.*\.sql$/.test(entry));
  if (!match) {
    throw new Error('No dated SQL snapshot file found in the repository root.');
  }
  return join(snapshotDir, match);
}

function main(): void {
  const prismaSchema = readFileSync(prismaSchemaPath, 'utf8');
  const sqlSnapshotPath = findSnapshotSqlFile();
  const sqlSnapshot = readFileSync(sqlSnapshotPath, 'utf8');

  const prismaModels = readPrismaModels(prismaSchema);
  const snapshotModels = readSqlSnapshotModels(sqlSnapshot);

  const missingFromSnapshot = [...prismaModels].filter((model) => !snapshotModels.has(model)).sort();
  const missingFromPrisma = [...snapshotModels].filter((model) => !prismaModels.has(model)).sort();

  const output = {
    backendPrismaModels: prismaModels.size,
    sqlSnapshotApplicationTables: snapshotModels.size,
    missingFromSnapshot,
    missingFromPrisma,
    liveDatabaseSchemaUnverified: true,
    source: {
      prismaSchema: prismaSchemaPath,
      sqlSnapshot: sqlSnapshotPath,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
