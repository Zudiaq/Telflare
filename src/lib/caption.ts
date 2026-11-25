export interface CaptionMetadata {
  f?: string;
  n?: string;
  t?: string;
  p?: number;
  tp?: number;
  pId?: string;
  id?: string;
  path?: string;
  dur?: number;
  totalDur?: number;
  offset?: number;
  audios?: unknown[];
  subs?: unknown[];
  s?: number;
  mime?: string;
  w?: number;
  h?: number;
}

const MAX_CAPTION_LENGTH = 1000;

const typeLabel = (type?: string): string => {
  if (type === 'video') return 'video';
  if (type === 'image') return 'image';
  if (type === 'audio') return 'audio';
  if (type === 'dir') return 'folder';
  return 'file';
};

export const buildTelegramCaption = (
  fileName: string,
  metadata: CaptionMetadata
): string => {
  const legacyMetadata: Record<string, unknown> = {};
  for (const key of ['n', 'f', 'p', 'tp', 't', 'pId', 'id', 'path', 'dur', 'totalDur', 'offset', 'audios', 'subs', 's', 'mime', 'w', 'h']) {
    if (key in metadata && metadata[key as keyof CaptionMetadata] !== undefined) {
      legacyMetadata[key] = metadata[key as keyof CaptionMetadata];
    }
  }
  const json = JSON.stringify(legacyMetadata)
    .replace(/":/g, '": ')
    .replace(/,(?=")/g, ', ');
  const partLabel = metadata.tp && metadata.tp > 1
    ? `📦 Part: ${metadata.p || 1}/${metadata.tp}\n`
    : '';
  const fullPrefix = `📄 File: ${fileName}\n🎞 Type: ${typeLabel(metadata.t)}\n${partLabel}\n`;

  if (fullPrefix.length + json.length <= MAX_CAPTION_LENGTH) {
    return `${fullPrefix}${json}`;
  }

  const availableNameLength = Math.max(
    1,
    MAX_CAPTION_LENGTH - json.length - `📄 File: \n🎞 Type: ${typeLabel(metadata.t)}\n${partLabel}\n`.length - 3
  );
  const shortenedName = `${fileName.slice(0, availableNameLength)}...`;
  return `📄 File: ${shortenedName}\n🎞 Type: ${typeLabel(metadata.t)}\n${partLabel}\n${json}`;
};
