/**
 * FastMessage — filestore.js
 * ----------------------------------------------------------------------------
 * Резервное хранилище файлов в Realtime Database (работает БЕЗ Firebase Storage
 * и без платного тарифа). Файл режется на куски base64 и лежит в
 * fileChunks/{ownerUid}/{fileId}/{0..n}. Читатель собирает куски обратно в Blob.
 */
import { ctx, ref, set, get } from './firebase.js';

export const CHUNK_CHARS = 240000;               // кратно 4 → безопасно для base64
export const CHUNKED_LIMIT = 15 * 1024 * 1024;   // максимум файла в резервном режиме

const urlCache = new Map();                      // "owner/fileId" → blob: URL
const inflight = new Map();

export const chunkKey = (m) => `${m.owner}/${m.fileId}`;
export const getCachedChunkUrl = (key) => urlCache.get(key) || '';

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    r.readAsDataURL(blob);
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Загружает Blob кусками в RTDB. Возвращает объект для поля media сообщения. */
export async function uploadChunked(blob, mime, onProgress) {
  if (!ctx.db || !ctx.uid) throw new Error('Нет подключения к базе.');
  const b64 = await blobToBase64(blob);
  const parts = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
  const fileId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const base = `fileChunks/${ctx.uid}/${fileId}`;

  let doneCount = 0;
  const queue = [...Array(parts).keys()];
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift();
      await set(ref(ctx.db, `${base}/${i}`), b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
      doneCount++;
      if (onProgress) onProgress(Math.round((doneCount / parts) * 100));
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // Отправителю файл доступен сразу, без повторной загрузки.
  urlCache.set(`${ctx.uid}/${fileId}`, URL.createObjectURL(blob));
  return { url: '', path: '', chunked: true, fileId, owner: ctx.uid, parts, mime: mime || blob.type || '' };
}

/** Скачивает и собирает файл. Результат кэшируется. */
export function loadChunked(media) {
  const key = chunkKey(media);
  if (urlCache.has(key)) return Promise.resolve(urlCache.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const snap = await get(ref(ctx.db, `fileChunks/${media.owner}/${media.fileId}`));
    if (!snap.exists()) throw new Error('Файл не найден.');
    const val = snap.val();
    const arr = Array.isArray(val) ? val : Object.keys(val).sort((a, b) => a - b).map((k) => val[k]);
    const blob = new Blob(arr.map((s) => base64ToBytes(s || '')), { type: media.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    urlCache.set(key, url);
    return url;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}
