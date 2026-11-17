import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/** `items` é público (fotos); `docs` é privado (documentos de ONG, só por URL assinada). */
export type Bucket = 'items' | 'docs';

export interface Storage {
  upload(bucket: Bucket, path: string, body: Buffer, contentType: string): Promise<void>;
  remove(bucket: Bucket, paths: string[]): Promise<void>;
  /** URL pública de um arquivo do bucket `items`. */
  publicUrl(path: string): string;
  /** URL assinada de um arquivo do bucket `docs`. */
  signedUrl(path: string, expiresInSec: number): Promise<string>;
}

export function createSupabaseStorage(): Storage {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const name = (bucket: Bucket) => (bucket === 'items' ? env.STORAGE_BUCKET_ITEMS : env.STORAGE_BUCKET_DOCS);

  return {
    async upload(bucket, path, body, contentType) {
      const { error } = await client.storage.from(name(bucket)).upload(path, body, { contentType, upsert: false });
      if (error) throw new Error(`Falha no upload para ${name(bucket)}/${path}: ${error.message}`);
    },
    async remove(bucket, paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from(name(bucket)).remove(paths);
      if (error) throw new Error(`Falha ao remover de ${name(bucket)}: ${error.message}`);
    },
    publicUrl(path) {
      return client.storage.from(env.STORAGE_BUCKET_ITEMS).getPublicUrl(path).data.publicUrl;
    },
    async signedUrl(path, expiresInSec) {
      const { data, error } = await client.storage.from(env.STORAGE_BUCKET_DOCS).createSignedUrl(path, expiresInSec);
      if (error || !data) throw new Error(`Falha ao assinar URL de ${path}: ${error?.message}`);
      return data.signedUrl;
    },
  };
}
