/**
 * What is about to be uploaded: each file with the path it should land at,
 * relative to the folder it is dropped into.
 *
 * A loose file's path is just its name. A file from inside a dropped (or
 * picked) folder keeps the folder's structure: dropping "books to read" puts
 * its files under "books to read/…".
 */

export interface UploadEntry {
  file: File;
  /** "photo.jpg", or "books to read/fiction/dune.pdf" for a folder's file. */
  relPath: string;
}

/** Files from an `<input type="file">`, with or without `webkitdirectory`. */
export function entriesFromFiles(files: readonly File[]): UploadEntry[] {
  return files.map((file) => ({
    file,
    // Set when the input picked a folder; empty for loose files.
    relPath: file.webkitRelativePath || file.name,
  }));
}

// The File and Directory Entries API, as much of it as this needs, typed
// narrowly so the walk below reads plainly.
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FsFileEntry extends FsEntry {
  file: (ok: (file: File) => void, fail: (err: unknown) => void) => void;
}
interface FsDirectoryEntry extends FsEntry {
  createReader: () => {
    readEntries: (ok: (entries: FsEntry[]) => void, fail: (err: unknown) => void) => void;
  };
}

const isHidden = (name: string) => name.startsWith('.');

function readFile(entry: FsFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

/** Every entry of a directory: `readEntries` hands them over in batches. */
async function readAll(dir: FsDirectoryEntry): Promise<FsEntry[]> {
  const reader = dir.createReader();
  const out: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([])),
    );
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(entry: FsEntry, prefix: string, out: UploadEntry[]): Promise<void> {
  // Hidden files (.DS_Store, .git) are not listed by Cairn, so they are not sent.
  if (isHidden(entry.name)) return;
  const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readFile(entry as FsFileEntry);
    if (file) out.push({ file, relPath });
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readAll(entry as FsDirectoryEntry)) {
      await walk(child, relPath, out);
    }
  }
}

/**
 * The files of a drop, walking into any folder dropped. Resolves to null when
 * the browser has no entries API, so the caller falls back to the plain list.
 * Must be called during the drop event: the item list empties afterwards.
 */
export function entriesFromDrop(data: DataTransfer): Promise<UploadEntry[] | null> {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  if (items.length === 0 || typeof items[0]!.webkitGetAsEntry !== 'function') {
    return Promise.resolve(null);
  }
  const roots: FsEntry[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry() as FsEntry | null;
    if (entry) roots.push(entry);
  }
  if (roots.length === 0) return Promise.resolve(null);
  return (async () => {
    const out: UploadEntry[] = [];
    for (const root of roots) await walk(root, '', out);
    return out;
  })();
}
