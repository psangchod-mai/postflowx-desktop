// Encodes/decodes PostFlowX ownership metadata stored in Premiere marker comments.
// Format: [PFX]\nkey=value\n...\n{optional json}

export type MarkerOwnerMeta = {
  owner: 'postflowx';
  ownerId: string;
  kind: string;
  shotId?: string;
  rev?: string;
  payloadJson?: string;
};

const PFX_TAG = '[PFX]';

export function encodeOwnerComment(meta: MarkerOwnerMeta): string {
  const lines = [
    PFX_TAG,
    `owner=${meta.owner}`,
    `ownerId=${meta.ownerId}`,
    `kind=${meta.kind}`,
  ];
  if (meta.shotId) lines.push(`shotId=${meta.shotId}`);
  if (meta.rev) lines.push(`rev=${meta.rev}`);
  if (meta.payloadJson) lines.push(meta.payloadJson);
  return lines.join('\n');
}

export function decodeOwnerComment(comments: string): MarkerOwnerMeta | null {
  if (!comments.includes(PFX_TAG)) return null;

  const kv: Record<string, string> = {};
  let payloadJson: string | undefined;

  for (const line of comments.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === PFX_TAG || trimmed === '') continue;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') kv[k] = v;
        }
        payloadJson = trimmed;
      } catch {
        // not valid JSON, skip
      }
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      kv[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }

  if (kv['owner'] !== 'postflowx' || !kv['ownerId'] || !kv['kind']) return null;

  return {
    owner: 'postflowx',
    ownerId: kv['ownerId']!,
    kind: kv['kind']!,
    shotId: kv['shotId'],
    rev: kv['rev'],
    payloadJson,
  };
}

export function isPostFlowXMarker(comments: string): boolean {
  return comments.includes(PFX_TAG) && comments.includes('owner=postflowx');
}
