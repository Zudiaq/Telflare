import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { Buffer } from 'buffer';
import bigInt from 'big-integer';

export const FAST_UPLOAD_MIN_SIZE = 10 * 1024 * 1024;
const PART_SIZE = 512 * 1024;
const CONCURRENCY = 4;
const MAX_PART_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 45000;
const MAX_TOTAL_PARTS = 8000;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Upload part timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);

export interface UploadControl {
  wait: () => Promise<void>;
  throwIfCancelled: () => void;
}

export const canFastUpload = (size: number): boolean =>
  size > FAST_UPLOAD_MIN_SIZE && Math.ceil(size / PART_SIZE) <= MAX_TOTAL_PARTS;

export const fastUploadBigFile = async (
  client: TelegramClient,
  file: Blob,
  name: string,
  onProgress?: (fraction: number) => void,
  control?: UploadControl
): Promise<Api.InputFileBig> => {
  const size = file.size;
  const totalParts = Math.ceil(size / PART_SIZE);
  const fileId = bigInt.randBetween(bigInt('-9223372036854775808'), bigInt('9223372036854775807'));

  let nextPart = 0;
  let donePartsCount = 0;
  let failure: any = null;
  onProgress?.(0);

  const worker = async () => {
    while (!failure) {
      await control?.wait();
      control?.throwIfCancelled();
      const index = nextPart++;
      if (index >= totalParts) return;

      const slice = file.slice(index * PART_SIZE, Math.min(size, (index + 1) * PART_SIZE));
      const bytes = Buffer.from(await slice.arrayBuffer());

      let attempt = 0;
      while (true) {
        try {
          await control?.wait();
          control?.throwIfCancelled();
          await withTimeout(client.invoke(new Api.upload.SaveBigFilePart({
            fileId: fileId as any,
            filePart: index,
            fileTotalParts: totalParts,
            bytes,
          })) as Promise<any>, REQUEST_TIMEOUT_MS);
          break;
        } catch (e) {
          control?.throwIfCancelled();
          attempt++;
          if (failure || attempt >= MAX_PART_RETRIES) throw e;
          await sleep(600 * attempt);
        }
      }

      donePartsCount++;
      if (onProgress) {
        onProgress(donePartsCount / totalParts);
      }
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, totalParts) }, () =>
    worker().catch((e) => { if (!failure) failure = e; })
  );
  await Promise.all(workers);
  if (failure) throw failure;

  return new Api.InputFileBig({ id: fileId as any, parts: totalParts, name });
};
