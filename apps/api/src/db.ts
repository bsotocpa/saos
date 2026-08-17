/*
 * THE POOL, AND HOW A TRANSACTION REACHES 792 CALL SITES (#48 part two).
 *
 * `app.db` was a bare `pg.Pool`. Pool.query() takes a connection, runs one statement and
 * releases it, so two consecutive `app.db.query` calls may run on DIFFERENT connections —
 * which means a `BEGIN` issued on one of them governs nothing that follows. There was no way
 * to make a multi-step service call atomic.
 *
 * WHY NOT THREAD A CLIENT THROUGH THE SIGNATURES. That is the obvious fix, and it is the
 * wrong one here. There are ~792 `app.db.query` call sites across nested helpers
 * (`createEngagement` → `createInvoice` → `nextInvoiceNumber` → `currentPriceBookVersion`,
 * and so on), and the failure mode of a MISSED thread-through is silent: that one statement
 * runs outside the transaction, commits on its own, and survives a rollback. A partial write
 * that nothing detects is precisely the bug #48 exists to remove, so a fix whose own failure
 * mode is a partial write is not a fix.
 *
 * AsyncLocalStorage inverts it. The transaction is ambient: `query` asks whether a
 * transaction is in progress on this async context and uses its client if so. Every existing
 * call site participates without being touched, every helper they call participates, and
 * anything added later participates by default rather than by remembering. The cost is that
 * the mechanism is implicit — hence this comment, and `withTransaction` being the only door.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

/**
 * What the app uses from the pool. Deliberately narrow: `query` for everything, `connect` for
 * the one place that manages its own client, `end` for shutdown.
 */
export interface Db {
  query: pg.Pool['query'];
  connect: pg.Pool['connect'];
  end: pg.Pool['end'];
}

/**
 * The transaction in progress on this async context, if any.
 *
 * AsyncLocalStorage propagates across `await`, so every statement issued anywhere beneath a
 * `withTransaction` callback finds it — including inside helpers that know nothing about
 * transactions.
 */
const txStore = new AsyncLocalStorage<pg.PoolClient>();

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  /*
   * ONE CAST, CONTAINED HERE. `pg.Pool['query']` is a set of generic overloads, and no single
   * arrow function satisfies all of them structurally. Casting once at this boundary keeps
   * every one of the 792 typed call sites — `query<{ id: string }>(sql, params)` — checking
   * exactly as it did against the real pool.
   */
  const query = ((...args: unknown[]) => {
    const client = txStore.getStore();
    return (client ?? pool).query(...(args as Parameters<pg.Pool['query']>));
  }) as pg.Pool['query'];

  return {
    query,
    // Passes through to the POOL, never to a transaction's client: a caller asking for its
    // own connection wants its own connection.
    connect: pool.connect.bind(pool),
    end: pool.end.bind(pool),
  };
}

/**
 * Run `fn` inside one database transaction. Everything it writes lands together or not at all.
 *
 * RE-ENTRANT, AND IT HAS TO BE — this is load-bearing, not tidiness. Removing the check to
 * test it did not produce a wrong answer; it HUNG THE SUITE. A nested call takes a SECOND
 * pool client and begins its own transaction, so when it touches a row the outer transaction
 * has locked it blocks in Postgres — while the outer blocks in JavaScript awaiting the inner.
 * Postgres cannot break that: it sees the inner waiting on a lock and the outer waiting on
 * nothing it knows about, so deadlock detection never fires and both wait forever. Joining
 * the existing transaction is what makes it safe to wrap a service call that some other
 * caller has already wrapped.
 *
 * The consequence to know: a failure inside the inner call rolls back the OUTER transaction
 * too, because there is only one. Savepoints would allow partial rollback and are deliberately
 * not here — nothing in this system has asked to half-fail, and "some of it committed" is the
 * state #48 exists to eliminate.
 *
 * OUTWARD EFFECTS DO NOT BELONG IN HERE. An email cannot be rolled back, and a transaction
 * holds a pool connection while it runs, so a send inside one is wrong twice over. Effects go
 * after the commit, where a failure raises a loud task instead of silently undoing a
 * commitment the client already made.
 */
export async function withTransaction<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const existing = txStore.getStore();
  if (existing) return fn();

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A rollback that itself fails must not replace the error that caused it — the original
    // is the one that explains what happened.
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Whether a transaction is in progress on this async context. For assertions and tests. */
export function inTransaction(): boolean {
  return txStore.getStore() !== undefined;
}
