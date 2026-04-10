export function sameOwnerAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export async function requireOwnedEntity<Row, Db>(
  db: Db,
  id: string,
  walletAddress: string,
  load: (db: Db, id: string) => Promise<Row | null>,
  getOwnerAddress: (row: Row) => string | null | undefined,
): Promise<Row | null> {
  const entity = await load(db, id);
  if (!entity) return null;
  return sameOwnerAddress(getOwnerAddress(entity), walletAddress) ? entity : null;
}
