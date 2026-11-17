import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { Db } from '../../src/core/db';
import type { NgoStatus, Role, User } from '../../src/types';
import { SESSION_COOKIE } from '../../src/core/session-cookie';

export const PASSWORD = 'Senha1234';
let hash: Promise<string> | undefined;
const passwordHash = () => (hash ??= bcrypt.hash(PASSWORD, 4)); // custo baixo só nos testes

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** CNPJ válido e único, já mascarado. */
export function randomCnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (digits: number[], weights: number[]) => {
    const rest = weights.reduce((acc, w, i) => acc + w * digits[i]!, 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join('').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export interface UserOpts {
  name?: string;
  email?: string;
  city?: string;
  state?: string;
}

export async function createUser(db: Db, role: Role, opts: UserOpts = {}): Promise<User> {
  const [row] = await db.sql<User[]>`
    INSERT INTO users (name, email, password_hash, role, city, state)
    VALUES (${opts.name ?? `${role} ${unique()}`}, ${opts.email ?? `${role.toLowerCase()}-${unique()}@teste.dev`},
            ${await passwordHash()}, ${role}, ${opts.city ?? 'São Paulo'}, ${opts.state ?? 'SP'})
    RETURNING *`;
  return row!;
}

export const createDonor = (db: Db, opts?: UserOpts) => createUser(db, 'DONOR', opts);
export const createAdmin = (db: Db, opts?: UserOpts) => createUser(db, 'ADMIN', opts);

export async function createNgo(
  db: Db,
  opts: UserOpts & { status?: NgoStatus; rejection_reason?: string } = {},
): Promise<User & { ngo_profile_id: string }> {
  const user = await createUser(db, 'NGO', opts);
  const [profile] = await db.sql<{ id: string }[]>`
    INSERT INTO ngo_profiles (user_id, cnpj, website, document_url, status, rejection_reason)
    VALUES (${user.id}, ${randomCnpj()}, ${null}, ${`${user.id}/${randomUUID()}.pdf`},
            ${opts.status ?? 'ATIVO'}, ${opts.rejection_reason ?? null})
    RETURNING id`;
  return { ...user, ngo_profile_id: profile!.id };
}

export const tokenFor = (app: FastifyInstance, user: Pick<User, 'id' | 'role'>) =>
  app.jwt.sign({ sub: user.id, role: user.role });

/** Cabeçalho `cookie` com a sessão (ADR-13). Aceita um usuário (assina na hora) ou um token pronto. */
export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}`;

export const authHeader = (app: FastifyInstance, user: Pick<User, 'id' | 'role'>) => ({
  cookie: sessionCookie(tokenFor(app, user)),
});

/** Token gravado no Set-Cookie de uma resposta (login, cadastro, troca de senha). */
export const tokenFromResponse = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c?.value) throw new Error('Resposta sem cookie de sessão');
  return c.value;
};

// ── Arquivos ──
export const pdfBuffer = () => Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

export const imageBuffer = (format: 'png' | 'jpeg' | 'webp' = 'png', size = 32) =>
  sharp({ create: { width: size, height: size, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    [format]()
    .toBuffer();

export interface ItemOpts {
  title?: string;
  description?: string | null;
  notes?: string | null;
  category?: 'ROUPAS' | 'BRINQUEDOS' | 'ALIMENTOS' | 'LIVROS';
  city?: string;
  state?: string;
  status?: 'DISPONIVEL' | 'EM_PROGRESSO' | 'DOADO';
  selected_ngo_id?: string | null;
  created_at?: Date;
}

/** Item com 3 fotos direto no banco (sem passar pelo upload). */
export async function createItem(db: Db, donor: Pick<User, 'id' | 'city' | 'state'>, opts: ItemOpts = {}) {
  const [item] = await db.sql<{ id: string; created_at: Date }[]>`
    INSERT INTO items (donor_id, title, description, notes, category, city, state, status, selected_ngo_id, created_at)
    VALUES (${donor.id}, ${opts.title ?? `Item ${unique()}`}, ${opts.description === undefined ? 'Em bom estado' : opts.description},
            ${opts.notes ?? null},
            ${opts.category ?? 'ROUPAS'}, ${opts.city ?? donor.city}, ${opts.state ?? donor.state},
            ${opts.status ?? 'DISPONIVEL'}, ${opts.selected_ngo_id ?? null}, ${opts.created_at ?? new Date()})
    RETURNING id, created_at`;
  for (let i = 0; i < 3; i++) {
    await db.sql`
      INSERT INTO item_photos (item_id, photo_url, created_at)
      VALUES (${item!.id}, ${`https://storage.test/items/${item!.id}/${i}.webp`}, ${new Date(item!.created_at.getTime() + i)})`;
  }
  return item!;
}

export async function addInterest(db: Db, itemId: string, ngoId: string) {
  await db.sql`INSERT INTO item_interests (item_id, ngo_id) VALUES (${itemId}, ${ngoId})`;
}
