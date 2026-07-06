// Minimal typings for @saos/db (plain-JS package; see its README for why).
declare module '@saos/db' {
  export function migrate(databaseUrl: string, direction?: 'up' | 'down'): Promise<unknown>;
  export function seedAll(client: unknown): Promise<string[]>;
}
