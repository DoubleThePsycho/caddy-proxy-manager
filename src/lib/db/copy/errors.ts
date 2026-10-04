/**
 * Refusals of the SQLite → PostgreSQL copy (copy.ts, verify.ts). The message
 * says what is wrong and what to do; it never contains a stored value.
 */
export class CopyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRefusedError";
  }
}
