/**
 * Read a complete ordered PostgREST result without depending on max_rows.
 * Callers must build a fresh query with a stable order (including a unique key).
 * A short page can mean a lower server cap, not the end of the table: advance
 * by the actual returned count and stop only on an empty page.
 * Never return a partial list as a successful result after a database error.
 */
export async function readAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string } }> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; ) {
    const { data, error } = await page(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    if (!data?.length) return { data: rows, error: null };
    rows.push(...data);
    offset += data.length;
  }
}
