/** The message of a thrown value, which may not be an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
