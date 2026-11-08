import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, resolve, posix } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import type { Connect, Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_MEDIA_FILE_SIZE, isSafeMediaFilename, mediaFileKind } from '../src/media-folder-contract.ts';
import type { MediaFolderFile, MediaFolderListing } from '../src/media-folder-contract.ts';

interface MediaOptions {
  platform?: string;
  execute?: (command: string, args: string[]) => Promise<unknown>;
}

type LocalRequest = Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string; encrypted?: boolean } };
type MediaMiddleware = Connect.NextHandleFunction & { close: () => Promise<void> };

class MediaError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function isLocalMediaRequest(req: LocalRequest): boolean {
  const remote = req.socket.remoteAddress;
  if (remote !== '::1' && remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') return false;
  const host = req.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(host)) return false;
  const scheme = req.socket.encrypted ? 'https:' : 'http:';
  let expected: string;
  try { expected = new URL(`${scheme}//${host}`).origin; } catch { return false; }
  if (req.headers.origin !== undefined && req.headers.origin !== expected) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

// Vite's native static server uses decodeURI, which preserves encoded # and ?.
// Only those filenames need direct streaming; normal assets stay on Vite's path.
async function serveReservedFilename(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MEDIA_FILE_SIZE) throw new MediaError(404, '素材が見つかりません。');
    let start = 0;
    let end = info.size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) throw new MediaError(416, '読み込み範囲が不正です。');
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        res.setHeader('Content-Range', `bytes */${info.size}`);
        throw new MediaError(416, '読み込み範囲が不正です。');
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };
    res.setHeader('Content-Type', types[extname(path).toLowerCase()]);
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD' || info.size === 0) { await handle.close(); res.end(); return; }
    const stream = handle.createReadStream({ start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) { await handle.close(); throw error; }
}

/** Native Vite middleware keeps video range requests and preview serving the live folder. */
export async function createMediaMiddleware(root: string, options: MediaOptions = {}): Promise<MediaMiddleware> {
  const projectRoot = resolve(root);
  const publicRoot = join(projectRoot, 'public');
  const folder = join(publicRoot, 'media');
  const canonicalPublicRoot = join(await realpath(projectRoot), 'public');
  const execute = options.execute ?? ((command, args) => promisify(execFile)(command, args, { shell: false, timeout: 10_000 }));
  const native = await createServer({
    configFile: false,
    root: canonicalPublicRoot,
    publicDir: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null, cors: false, fs: { strict: true, allow: [canonicalPublicRoot] } },
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  async function ensureFolder(): Promise<void> {
    const canonicalProject = await realpath(projectRoot);
    // Checking public first avoids creating a folder through an external symlink.
    try {
      if ((await lstat(publicRoot)).isSymbolicLink() || await realpath(publicRoot) !== join(canonicalProject, 'public')) throw new MediaError(403, '素材フォルダの場所を確認してください。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(publicRoot);
    }
    try {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError(403, '素材フォルダにリンクは使用できません。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(folder);
    }
    if (await realpath(folder) !== join(canonicalProject, 'public', 'media')) throw new MediaError(403, '素材フォルダの場所を確認してください。');
  }

  async function describeFile(name: string): Promise<MediaFolderFile | null> {
    if (!isSafeMediaFilename(name)) return null;
    const kind = mediaFileKind(name);
    if (!kind) return null;
    try {
      const info = await lstat(join(folder, name));
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MEDIA_FILE_SIZE) return null;
      return { name, kind, size: info.size, modified: info.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const original = req.url ?? '/';
    const rawPath = original.split('?')[0];
    let path: string;
    try { path = decodeURIComponent(rawPath); } catch {
      if (/media/i.test(rawPath)) { json(res, 400, { error: '素材のパスが不正です。' }); return; }
      next(); return;
    }
    const normalized = posix.normalize(path.replaceAll('\\', '/'));
    const folded = normalized.toLowerCase();
    const isApi = path === '/__media' || path.startsWith('/__media/');
    const isAsset = path === '/media' || path.startsWith('/media/');
    const protectedAlias = folded.startsWith('/media/') || folded.startsWith('/__media/') || folded === '/public/media' || folded.startsWith('/public/media/') || (folded.startsWith('/@fs/') && [folder, join(canonicalPublicRoot, 'media')].some(location => folded.includes(location.replaceAll('\\', '/').toLowerCase())));
    if (!isApi && !isAsset && !protectedAlias) { next(); return; }

    void (async () => {
      if (!isLocalMediaRequest(req)) throw new MediaError(403, '素材はこの端末の画面から操作してください。');
      if (!isApi && !isAsset) throw new MediaError(403, 'この素材パスは利用できません。');
      if (path !== normalized || original.includes('#')) throw new MediaError(400, '素材のパスが不正です。');
      if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new MediaError(400, '素材の操作に本文は指定できません。');

      if (isApi) {
        if (path !== '/__media/list' && path !== '/__media/open') throw new MediaError(404, '素材の操作が見つかりません。');
        if (original.includes('?')) throw new MediaError(400, '素材の場所は変更できません。');
        const method = path === '/__media/list' ? 'GET' : 'POST';
        if (req.method !== method) { res.setHeader('Allow', method); throw new MediaError(405, 'この操作方法は利用できません。'); }
        await ensureFolder();
        if (method === 'POST') {
          const platform = options.platform ?? process.platform;
          const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
          await execute(command, [folder]);
          json(res, 200, { path: folder });
          return;
        }
        const entries = await Promise.all((await readdir(folder)).map(describeFile));
        const files = entries.filter((entry): entry is MediaFolderFile => entry !== null).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        const listing: MediaFolderListing = { path: folder, files };
        json(res, 200, listing);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); throw new MediaError(405, 'この操作方法は利用できません。'); }
      await ensureFolder();
      const file = await describeFile(path.slice('/media/'.length));
      if (!file) throw new MediaError(404, '素材が見つかりません。');
      // Strip query parameters so an asset cannot become a Vite import/transform request.
      req.url = '/media/' + encodeURIComponent(file.name);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (/[#?]/.test(file.name)) {
        await serveReservedFilename(req, res, join(folder, file.name));
        return;
      }
      native.middlewares(req, res, error => {
        req.url = original;
        if (error) json(res, 500, { error: '素材を読み込めませんでした。' });
        else json(res, 404, { error: '素材が見つかりません。' });
      });
    })().catch(error => {
      if (!res.headersSent) json(res, error instanceof MediaError ? error.status : 500, { error: error instanceof MediaError ? error.message : '素材フォルダを操作できませんでした。' });
      else res.destroy();
    });
  };
  return Object.assign(middleware, { close: () => native.close() });
}

export function localMediaPlugin(options: MediaOptions = {}): Plugin {
  return {
    name: 'vj-local-media',
    async configureServer(server) {
      const media = await createMediaMiddleware(server.config.root, options);
      server.middlewares.use(media);
      server.httpServer?.once('close', () => { void media.close(); });
    },
    async configurePreviewServer(server) {
      const media = await createMediaMiddleware(server.config.root, options);
      server.middlewares.use(media);
      server.httpServer.once('close', () => { void media.close(); });
    },
  };
}
