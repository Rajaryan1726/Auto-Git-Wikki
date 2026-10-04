import { createHash } from 'node:crypto';

/** Fixed namespace for AutoWiki chunk ids. Changing it would orphan every stored point. */
export const POINT_ID_NAMESPACE = '6f1c2b8e-4d3a-5e7f-9a1b-0c2d3e4f5a6b';

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Invalid UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 version-5 (SHA-1, name-based) UUID. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(hash);
}

/**
 * Deterministic Qdrant point id for a chunk, so re-running an index step upserts the
 * same points instead of duplicating them. JSON encoding keeps the parts unambiguous.
 */
export function chunkPointId(
  repoId: string,
  commitSha: string,
  filePath: string,
  startLine: number,
): string {
  return uuidV5(JSON.stringify([repoId, commitSha, filePath, startLine]), POINT_ID_NAMESPACE);
}
