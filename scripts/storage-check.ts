// npm run storage:check — confere (e cria, se faltar) os buckets do Supabase Storage
// e testa ponta a ponta: upload, URL pública, bloqueio do bucket privado e URL assinada.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { env } from '../src/core/env';
import { createSupabaseStorage } from '../src/core/storage';

const MB = 1024 * 1024;
const BUCKETS = [
  {
    name: env.STORAGE_BUCKET_ITEMS,
    public: true,
    // A API sempre converte as fotos para webp antes de subir.
    options: { public: true, fileSizeLimit: 5 * MB, allowedMimeTypes: ['image/webp'] },
  },
  {
    name: env.STORAGE_BUCKET_DOCS,
    public: false,
    options: {
      public: false,
      fileSizeLimit: 5 * MB,
      allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    },
  },
];

const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.error(`  ✘ ${msg}`);
};

async function ensureBuckets() {
  console.log(`Buckets em ${env.SUPABASE_URL}`);
  const { data: existing, error } = await client.storage.listBuckets();
  if (error) throw new Error(`Não foi possível listar buckets (confira SUPABASE_SERVICE_ROLE_KEY): ${error.message}`);

  for (const b of BUCKETS) {
    const found = existing.find((e) => e.name === b.name);
    if (!found) {
      const { error: createError } = await client.storage.createBucket(b.name, b.options);
      if (createError) fail(`criar bucket "${b.name}": ${createError.message}`);
      else ok(`bucket "${b.name}" criado (${b.public ? 'público' : 'privado'}, até 5 MB)`);
    } else if (found.public !== b.public) {
      fail(`bucket "${b.name}" existe mas está ${found.public ? 'público' : 'privado'}; deveria ser ${b.public ? 'público' : 'privado'}`);
    } else {
      ok(`bucket "${b.name}" existe e está ${b.public ? 'público' : 'privado'}`);
    }
  }
}

async function roundTrip() {
  console.log('Ida e volta pelo adapter da API');
  const storage = createSupabaseStorage();
  const id = `_healthcheck/${randomUUID()}`;
  const photoPath = `${id}.webp`;
  const docPath = `${id}.pdf`;

  const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2563eb' } }).webp().toBuffer();
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');

  try {
    await storage.upload('items', photoPath, photo, 'image/webp');
    ok('upload de foto no bucket público');
    const publicRes = await fetch(storage.publicUrl(photoPath));
    if (publicRes.ok) ok('foto abre pela URL pública');
    else fail(`foto não abre pela URL pública (HTTP ${publicRes.status})`);

    await storage.upload('docs', docPath, pdf, 'application/pdf');
    ok('upload de documento no bucket privado');
    const leakUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${env.STORAGE_BUCKET_DOCS}/${docPath}`;
    const leak = await fetch(leakUrl);
    if (leak.ok) fail('documento abriu por URL pública: o bucket de documentos está exposto!');
    else ok(`documento NÃO abre por URL pública (HTTP ${leak.status})`);

    const signed = await fetch(await storage.signedUrl(docPath, 60));
    if (signed.ok) ok('documento abre pela URL assinada');
    else fail(`documento não abre pela URL assinada (HTTP ${signed.status})`);
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  } finally {
    await storage.remove('items', [photoPath]).catch(() => {});
    await storage.remove('docs', [docPath]).catch(() => {});
    ok('arquivos de teste removidos');
  }
}

try {
  await ensureBuckets();
  if (failures === 0) await roundTrip();
} catch (err) {
  fail(String(err instanceof Error ? err.message : err));
}

console.log(failures === 0 ? '\nSupabase Storage OK.' : `\n${failures} problema(s) no Supabase Storage.`);
process.exitCode = failures === 0 ? 0 : 1;
