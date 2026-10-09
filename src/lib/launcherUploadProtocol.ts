/**
 * Binary Colonial Helper uploads use raw HTTP chunks rather than multipart.
 * Four MiB stays below common ingress/serverless request-body ceilings while
 * remaining large enough to avoid hundreds of round trips for a normal EXE.
 * The client automatically falls back to one MiB when an outer proxy is stricter.
 */
export const LAUNCHER_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MIN_LAUNCHER_UPLOAD_CHUNK_BYTES = 1 * 1024 * 1024;
export const MAX_LAUNCHER_UPLOAD_BYTES = 128 * 1024 * 1024;
