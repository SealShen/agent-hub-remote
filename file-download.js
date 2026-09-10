import fs from 'node:fs';
import path from 'node:path';

export class FileDownloadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function resolveSessionDownload(cwd, requestedPath) {
  const requested = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (!requested || !path.isAbsolute(requested)) {
    throw new FileDownloadError(400, 'absolute file path required');
  }

  let root;
  let target;
  try {
    root = fs.realpathSync(cwd);
    target = fs.realpathSync(requested);
  } catch {
    throw new FileDownloadError(404, 'file not found');
  }

  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FileDownloadError(403, 'file is outside the session workspace');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new FileDownloadError(404, 'file not found');
  }
  if (!stat.isFile()) throw new FileDownloadError(400, 'path is not a file');
  return target;
}
