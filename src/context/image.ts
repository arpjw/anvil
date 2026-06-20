import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
};

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export function loadImage(filepath: string): ImageContentBlock {
  if (!existsSync(filepath)) {
    throw new Error(`Image file not found: ${filepath}`);
  }

  const ext = extname(filepath).toLowerCase();
  const mediaType = SUPPORTED_EXTENSIONS[ext];

  if (!mediaType) {
    const supported = Object.keys(SUPPORTED_EXTENSIONS).join(', ');
    throw new Error(`Unsupported image format "${ext}". Supported: ${supported}`);
  }

  const data = readFileSync(filepath).toString('base64');

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data,
    },
  };
}
