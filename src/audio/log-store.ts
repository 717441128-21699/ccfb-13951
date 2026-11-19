/**
 * 通联日志持久化(IndexedDB)。刷新页面后日志仍在。
 */
import type { QsoRecord } from '../sstv/adif';

const DB_NAME = 'web-sstv';
const DB_VERSION = 1;
const STORE = 'qso';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class LogStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await openDb();
  }

  async add(record: QsoRecord): Promise<void> {
    if (!this.db) await this.init();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async update(record: QsoRecord): Promise<void> {
    return this.add(record);
  }

  async all(): Promise<QsoRecord[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as QsoRecord[]).sort((a, b) => b.timeOn.localeCompare(a.timeOn)));
      req.onerror = () => reject(req.error);
    });
  }

  async remove(id: string): Promise<void> {
    if (!this.db) await this.init();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    if (!this.db) await this.init();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
