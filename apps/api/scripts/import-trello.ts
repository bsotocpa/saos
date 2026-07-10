// Trello import CLI (M25). Point it at Trello board-export JSON files:
//
//   node scripts/import-trello.ts ../../migration-data/trello/*.json
//
// Idempotent: reruns skip already-imported cards (Trello card id = task
// source_id). Prints counts only.

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { buildServer } from '../src/server.ts';
import { importTrelloBoard, type TrelloExport } from '../src/migration/trello.ts';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node scripts/import-trello.ts <board-export.json> [...more]');
  process.exit(1);
}

const app = buildServer(loadConfig());
try {
  for (const file of files) {
    const data = JSON.parse(await readFile(file, 'utf8')) as TrelloExport;
    const r = await importTrelloBoard(app, data);
    console.log(
      `trello: "${r.board}" — ${r.columns} columns, ${r.tasksCreated} tasks created, ` +
        `${r.tasksSkipped} already imported, ${r.assigneesMatched} assignees matched, ${r.checklistItems} checklist items`
    );
  }
} finally {
  await app.close();
}
