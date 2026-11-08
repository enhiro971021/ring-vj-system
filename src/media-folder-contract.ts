export const MAX_MEDIA_FILE_SIZE = 200 * 1024 * 1024;

export interface MediaFolderFile {
  name: string;
  kind: 'logo' | 'video';
  size: number;
  modified: number;
}

export interface MediaFolderListing {
  path: string;
  files: MediaFolderFile[];
}

export function isSafeMediaFilename(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name !== '.' && !name.includes('..') && !/[\\/\u0000-\u001f\u007f-\u009f]/.test(name);
}

export function mediaFileKind(name: string): MediaFolderFile['kind'] | null {
  if (typeof name !== 'string') return null;
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) return 'logo';
  if (/\.(mp4|m4v|webm)$/i.test(name)) return 'video';
  return null;
}
