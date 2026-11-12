import { mkdir, link, unlink, stat, lstat, readdir } from 'node:fs/promises';
import { createWriteStream, lstatSync, realpathSync, type WriteStream } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { uuidv7 } from 'uuidv7';
import { getStorageConfig } from '../../config/storage.js';

export interface StorageService {
  init(): Promise<void>;
  getTempDir(): string;
  createTempFilePath(prefix?: string): string;
  createTempWriteStream(tempFileName: string): { writeStream: WriteStream; tempFilePath: string };
  commitFile(tempFilePath: string, storageKey: string): Promise<void>;
  unlinkFile(storageKeyOrPath: string): Promise<boolean>;
  resolvePath(storageKey: string): string;
  cleanupStaleTempFiles(
    maxAgeMs?: number,
    isActiveCheck?: (assetId: string) => Promise<boolean>
  ): Promise<{ deleted: number; errors: number }>;
  fileExists(storageKeyOrPath: string): Promise<boolean>;
}

export class LocalStorageService implements StorageService {
  private baseDir: string;
  private tempDir: string;
  private isCustomBaseDir: boolean;
  private configuredRoot: string | undefined;
  private canonicalRoot: string | undefined;

  constructor(baseDir?: string) {
    this.isCustomBaseDir = Boolean(baseDir);
    const config = getStorageConfig();
    this.baseDir = resolve(baseDir ?? config.baseDir);
    this.tempDir = resolve(this.baseDir, '.tmp');
  }

  async init(): Promise<void> {
    if (!this.isCustomBaseDir) {
      const config = getStorageConfig();
      this.baseDir = config.baseDir;
      this.tempDir = resolve(this.baseDir, '.tmp');
    }
    await mkdir(this.storageRoot(), { recursive: true });
    await mkdir(this.getTempDir(), { recursive: true });
    this.getTempDir(); // Recheck after creation, before handing paths to callers.
  }

  getTempDir(): string {
    this.tempDir = this.resolvePath('.tmp');
    return this.tempDir;
  }

  createTempFilePath(prefix: string = 'tmp'): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('Invalid temporary file prefix');
    return this.checkedPath(resolve(this.getTempDir(), `${prefix}-${uuidv7()}.tmp`));
  }

  createTempWriteStream(tempFileName: string): { writeStream: WriteStream; tempFilePath: string } {
    if (!tempFileName || tempFileName !== basename(tempFileName) || /[\\\0]/.test(tempFileName)) {
      throw new Error('Invalid temporary file name');
    }
    const tempFilePath = this.checkedPath(resolve(this.getTempDir(), tempFileName));
    if (dirname(tempFilePath) !== this.getTempDir()) throw new Error('Invalid temporary file name');
    // Exclusive creation also refuses an existing leaf symlink.
    const writeStream = createWriteStream(tempFilePath, { flags: 'wx', mode: 0o600 });
    return { writeStream, tempFilePath };
  }

  async commitFile(tempFilePath: string, storageKey: string): Promise<void> {
    const sourcePath = this.checkedPath(tempFilePath);
    if (dirname(sourcePath) !== this.getTempDir() || !(await lstat(sourcePath)).isFile()) {
      throw new Error('Only regular temporary storage files can be promoted');
    }
    const destinationPath = this.resolvePath(storageKey);
    await mkdir(dirname(destinationPath), { recursive: true });
    this.checkedPath(sourcePath);
    this.checkedPath(destinationPath);
    // Same-filesystem hard-link publication is atomic and never replaces an existing output.
    await link(sourcePath, destinationPath);
    // Once published, a failed temp unlink must not turn success into an ambiguous promotion.
    await this.unlinkFile(sourcePath);
  }

  async unlinkFile(storageKeyOrPath: string): Promise<boolean> {
    try {
      const targetPath = isAbsolute(storageKeyOrPath)
        ? this.checkedPath(storageKeyOrPath)
        : this.resolvePath(storageKeyOrPath);

      try {
        await unlink(targetPath);
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        console.warn(`[storage] Failed to delete file "${targetPath}":`, (err as Error).message);
        return false;
      }
    } catch (err: unknown) {
      console.warn(`[storage] Path resolution error during cleanup:`, (err as Error).message);
      return false;
    }
  }

  async fileExists(storageKeyOrPath: string): Promise<boolean> {
    try {
      const targetPath = isAbsolute(storageKeyOrPath)
        ? this.checkedPath(storageKeyOrPath)
        : this.resolvePath(storageKeyOrPath);
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleans up temporary files in the .tmp directory that exceed the maximum age.
   * Never removes temporary files that belong to actively uploading assets.
   * Default max age: 2 hours.
   */
  async cleanupStaleTempFiles(
    maxAgeMs: number = 2 * 60 * 60 * 1000,
    isActiveCheck?: (assetId: string) => Promise<boolean>
  ): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;

    const tempDir = this.getTempDir();

    try {
      const entries = await readdir(tempDir);
      const now = Date.now();

      for (const entry of entries) {
        const fullPath = resolve(tempDir, entry);
        try {
          this.checkedPath(fullPath);
          const fileStat = await lstat(fullPath);
          if (!fileStat.isFile()) continue;

          // Never delete files modified within the max age window
          if (now - fileStat.mtimeMs <= maxAgeMs) {
            continue;
          }

          // If an active check is provided, check if the file belongs to an active upload
          if (isActiveCheck) {
            const match = entry.match(/^([0-9a-fA-F-]+)\.upload\.tmp$/);
            if (match && match[1]) {
              const isActive = await isActiveCheck(match[1]);
              if (isActive) {
                // Preserved: belongs to an active upload
                continue;
              }
            }
          }

          if (await this.unlinkFile(fullPath)) deleted++;
          else errors++;
        } catch (fileErr) {
          errors++;
          console.warn(`[storage] Failed to remove stale temporary file "${fullPath}":`, (fileErr as Error).message);
        }
      }
    } catch (dirErr) {
      console.warn(`[storage] Unable to inspect temp directory for stale cleanup:`, (dirErr as Error).message);
    }

    return { deleted, errors };
  }

  /** Canonicalize the existing ancestor, retaining missing suffixes for new installations. */
  private storageRoot(): string {
    const configured = this.isCustomBaseDir ? this.baseDir : getStorageConfig().baseDir;
    if (configured !== this.configuredRoot || !this.canonicalRoot) {
      this.canonicalRoot = this.canonicalize(configured);
      this.configuredRoot = configured;
    }
    if (this.canonicalize(this.canonicalRoot) !== this.canonicalRoot) {
      throw new Error('Security violation: storage root was replaced by a symlink');
    }
    return this.canonicalRoot;
  }

  private canonicalize(path: string): string {
    let ancestor = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try { return resolve(realpathSync(ancestor), ...missing); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // lstat distinguishes an absent component from a dangling configured symlink.
        try {
          if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Dangling storage root symlink');
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        missing.unshift(basename(ancestor));
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  private checkedPath(path: string): string {
    const root = this.storageRoot();
    const fullPath = resolve(path);
    const suffix = relative(root, fullPath);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error('Security violation: storage path is outside its root');
    }
    // Reject every existing symlink below the canonical root, including dangling leaves.
    let current = root;
    for (const component of suffix.split(sep)) {
      current = resolve(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Security violation: storage symlink');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    return fullPath;
  }

  resolvePath(storageKey: string): string {
    if (!storageKey || storageKey.includes('\0') || isAbsolute(storageKey) || win32.isAbsolute(storageKey)) {
      throw new Error('Security violation: storage keys must be relative paths');
    }
    return this.checkedPath(resolve(this.storageRoot(), storageKey));
  }
}

export const defaultStorageService = new LocalStorageService();
