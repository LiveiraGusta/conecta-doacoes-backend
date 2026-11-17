import type { Bucket, Storage } from '../../src/core/storage';

export interface FakeStorage extends Storage {
  files: Map<string, { body: Buffer; contentType: string }>;
  /** Faz o próximo upload falhar (para testar limpeza). */
  failNextUpload(): void;
}

const key = (bucket: Bucket, path: string) => `${bucket}/${path}`;

export function fakeStorage(): FakeStorage {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  let failNext = false;

  return {
    files,
    failNextUpload() {
      failNext = true;
    },
    async upload(bucket, path, body, contentType) {
      if (failNext) {
        failNext = false;
        throw new Error('upload falhou (fake)');
      }
      files.set(key(bucket, path), { body, contentType });
    },
    async remove(bucket, paths) {
      for (const p of paths) files.delete(key(bucket, p));
    },
    publicUrl(path) {
      return `https://storage.test/items/${path}`;
    },
    async signedUrl(path, expiresInSec) {
      return `https://storage.test/ngo-docs/${path}?token=fake&expires=${expiresInSec}`;
    },
  };
}
