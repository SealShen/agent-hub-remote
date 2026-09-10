import fs from 'node:fs';
import path from 'node:path';

import { FileDownloadError } from './file-download.js';

const UPLOAD_NAME_RE = /^ahr_\d+_[a-z0-9]{5}_/;
const INLINE_IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
]);

export function resolveUploadDownload(mediaDir, name) {
  const requested = typeof name === 'string' ? name : '';
  if (!requested || requested.includes('..') || requested.includes('/') || requested.includes('\\')
      || path.isAbsolute(requested) || !UPLOAD_NAME_RE.test(requested)) {
    throw new FileDownloadError(400, 'invalid upload name');
  }

  let root;
  let target;
  try {
    root = fs.realpathSync(mediaDir);
    target = fs.realpathSync(path.join(root, requested));
  } catch {
    throw new FileDownloadError(404, 'upload expired');
  }

  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FileDownloadError(403, 'upload is outside the media directory');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new FileDownloadError(404, 'upload expired');
  }
  if (!stat.isFile()) throw new FileDownloadError(400, 'upload is not a file');
  return target;
}

export function previewDispositionFor(name) {
  const contentType = INLINE_IMAGE_TYPES.get(path.extname(String(name || '')).toLowerCase());
  return contentType
    ? { inline: true, contentType }
    : { inline: false, contentType: 'application/octet-stream' };
}
