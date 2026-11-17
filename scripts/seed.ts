// npm run seed — cria o Admin a partir de ADMIN_EMAIL/ADMIN_PASSWORD (idempotente).
// Com SEED_DEMO=true, cria também as contas e os itens de demo do roadmap.
// As variáveis do seed ficam fora do env.ts da API e são lidas só aqui.
import sharp from 'sharp';
import { createDb, type Db } from '../src/core/db';
import { bcryptHasher, PASSWORD_RULE } from '../src/core/passwords';
import { createSupabaseStorage, type Storage } from '../src/core/storage';
import { createAdminService } from '../src/modules/admin/admin.service';
import { adminRepository } from '../src/modules/admin/admin.repository';
import { authRepository } from '../src/modules/auth/auth.repository';
import { createAuthService } from '../src/modules/auth/auth.service';
import { itemEventsRepository } from '../src/modules/items/item-events.repository';
import { itemsRepository } from '../src/modules/items/items.repository';
import { createItemsService } from '../src/modules/items/items.service';
import type { AuthUser, Category } from '../src/types';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const seedDemo = process.env.SEED_DEMO === 'true';

if (!email || !password) {
  console.error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env para rodar o seed.');
  process.exit(1);
}
if (password.length < PASSWORD_RULE.min || password.length > PASSWORD_RULE.max || !PASSWORD_RULE.test(password)) {
  const msg = `ADMIN_PASSWORD fora da regra: ${PASSWORD_RULE.min}–${PASSWORD_RULE.max} caracteres, com letra e número.`;
  if (process.env.NODE_ENV === 'production') {
    console.error(msg);
    process.exit(1);
  }
  // Em dev a senha fraca é tolerada (ex.: "root" provisório), mas fica o aviso.
  console.warn(`AVISO: ${msg} Aceita só porque NODE_ENV não é production.`);
}

async function seedAdmin(db: Db) {
  if (await authRepository.findByEmail(db.sql, email!)) {
    console.log(`Admin ${email} já existe.`);
    return;
  }
  await authRepository.insertUser(db.sql, {
    name: 'Administrador',
    email: email!,
    password_hash: await bcryptHasher.hash(password),
    role: 'ADMIN',
    city: 'São Paulo',
    state: 'SP',
  });
  console.log(`Admin ${email} criado.`);
}

// ── Demo ──
const DEMO_PASSWORD = 'Demo1234';
const DEMO = {
  donor: { name: 'Marina Souza', email: 'doadora@demo.conectadoacoes.local' },
  ngoActive: { name: 'ONG Salvadora', email: 'ong.ativa@demo.conectadoacoes.local', cnpj: '11.222.333/0001-81' },
  ngoPending: { name: 'Instituto Novo Começo', email: 'ong.pendente@demo.conectadoacoes.local', cnpj: '45.997.418/0001-53' },
};

const DEMO_ITEMS: { title: string; description: string; notes?: string; category: Category; color: string }[] = [
  { title: 'Casaco infantil tamanho 6', description: 'Pouco usado, forrado, ideal para o inverno.', notes: 'Retirada em Bela Vista, de segunda a sexta depois das 18h.', category: 'ROUPAS', color: '#2563eb' },
  { title: 'Kit de livros didáticos 5º ano', description: 'Português, matemática e ciências, sem rasuras.', category: 'LIVROS', color: '#16a34a' },
  { title: 'Bicicleta aro 20', description: 'Pneus novos, precisa só de ajuste no freio.', notes: 'Posso levar até a ONG se for na zona central.', category: 'BRINQUEDOS', color: '#e11d48' },
  { title: 'Cesta básica fechada', description: 'Arroz, feijão, óleo, açúcar e café. Validade até 2027.', category: 'ALIMENTOS', color: '#d97706' },
  { title: 'Lote de roupas de bebê', description: 'Bodies e macacões de 0 a 6 meses.', category: 'ROUPAS', color: '#7c3aed' },
  { title: 'Jogos de tabuleiro', description: 'Três jogos completos, caixas um pouco gastas.', category: 'BRINQUEDOS', color: '#0891b2' },
];

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Foto de demo: fundo colorido com o título do item e o número da foto. */
const demoPhoto = (title: string, color: string, n: number) =>
  sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
      <rect width="100%" height="100%" fill="${color}"/>
      <circle cx="${300 + n * 300}" cy="450" r="${120 + n * 40}" fill="#ffffff" fill-opacity="0.15"/>
      <text x="60" y="800" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${escapeXml(title)}</text>
      <text x="60" y="110" font-family="Arial, sans-serif" font-size="44" fill="#ffffff" fill-opacity="0.85">Foto ${n} de 3 · demo</text>
    </svg>`),
  )
    .jpeg({ quality: 85 })
    .toBuffer();

async function seedDemoData(db: Db, storage: Storage) {
  if (await authRepository.findByEmail(db.sql, DEMO.donor.email)) {
    console.log('Dados de demo já existem.');
    return;
  }

  const auth = createAuthService({ db, authRepo: authRepository, storage, hasher: bcryptHasher, signToken: () => '' });
  const admin = createAdminService({ db, adminRepo: adminRepository, storage });
  const items = createItemsService({ db, itemsRepo: itemsRepository, eventsRepo: itemEventsRepository, storage });
  const place = { city: 'São Paulo', state: 'SP' };
  const pdf = Buffer.from('%PDF-1.4\n% Documento de demonstração\n%%EOF\n');

  const donor = (await auth.registerDonor({ ...DEMO.donor, ...place, password: DEMO_PASSWORD })).user;
  const ngoActive = (await auth.registerNgo({ ...DEMO.ngoActive, ...place, password: DEMO_PASSWORD, website: 'https://ongsalvadora.org.br' }, [pdf])).user;
  await auth.registerNgo({ ...DEMO.ngoPending, ...place, password: DEMO_PASSWORD }, [pdf]);
  await admin.updateNgoStatus(ngoActive.ngo_profile!.id, 'ATIVO');

  const donorCtx: AuthUser = { id: donor.id, role: 'DONOR', ...place, ngoStatus: null };
  for (const [i, it] of DEMO_ITEMS.entries()) {
    const photos = await Promise.all([1, 2, 3].map((n) => demoPhoto(it.title, it.color, n)));
    const item = await items.publish(donorCtx, it, photos);
    // O primeiro item já chega com uma curtida, para a demo mostrar "VER INTERESSADOS (1)".
    if (i === 0) await db.sql`INSERT INTO item_interests (item_id, ngo_id) VALUES (${item.id}, ${ngoActive.id})`;
    console.log(`  item ${i + 1}/6: ${it.title}`);
  }

  console.log(`Demo criada (senha de todas as contas: ${DEMO_PASSWORD}):`);
  console.log(`  doadora      ${DEMO.donor.email}`);
  console.log(`  ONG ativa    ${DEMO.ngoActive.email}`);
  console.log(`  ONG pendente ${DEMO.ngoPending.email}`);
}

const db = createDb();
try {
  await seedAdmin(db);
  if (seedDemo) await seedDemoData(db, createSupabaseStorage());
} catch (err) {
  console.error('Falha no seed:', err);
  process.exitCode = 1;
} finally {
  await db.close();
}
