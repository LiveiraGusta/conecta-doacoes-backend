// Tipos de domínio: iguais às linhas do banco (snake_case), sem lógica.

export type Role = 'DONOR' | 'NGO' | 'ADMIN';
export type NgoStatus = 'PENDENTE_APROVACAO' | 'ATIVO' | 'REJEITADO';
export type Category = 'ROUPAS' | 'BRINQUEDOS' | 'ALIMENTOS' | 'LIVROS';
export type ItemStatus = 'DISPONIVEL' | 'EM_PROGRESSO' | 'DOADO';
/** Status que aparece em item_events (CANCELADO nunca fica gravado em items.status). */
export type EventStatus = ItemStatus | 'CANCELADO';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  city: string;
  state: string;
  created_at: Date;
  updated_at?: Date | null;
  password_changed_at?: Date | null;
  deleted_at?: Date | null;
}

export interface NgoProfile {
  id: string;
  user_id: string;
  cnpj: string;
  website: string | null;
  document_url: string; // caminho no bucket privado
  status: NgoStatus;
  rejection_reason: string | null;
}

/** Usuário com o perfil de ONG (quando role = NGO). */
export interface UserWithProfile extends User {
  ngo_profile: NgoProfile | null;
}

/** O que o hook de autenticação lê do banco a cada requisição. */
export interface AuthContext extends AuthUser {
  /** Tokens emitidos antes disto são recusados. */
  passwordChangedAt: Date | null;
}

/** O que o hook de autenticação coloca em request.user. */
export interface AuthUser {
  id: string;
  role: Role;
  city: string;
  state: string;
  ngoStatus: NgoStatus | null;
}

export interface Item {
  id: string;
  donor_id: string;
  title: string;
  description: string | null;
  /** Observações do doador (retirada, conservação…). Só no detalhe do item. */
  notes: string | null;
  category: Category;
  city: string;
  state: string;
  status: ItemStatus;
  selected_ngo_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface ItemPhoto {
  id: string;
  item_id: string;
  photo_url: string;
  created_at: Date;
}

export interface ItemInterest {
  id: string;
  item_id: string;
  ngo_id: string;
  created_at: Date;
}

export interface ChatMessage {
  id: string;
  item_id: string;
  sender_id: string;
  receiver_id: string;
  message: string;
  created_at: Date;
}

export interface ItemEvent {
  id: string;
  item_id: string;
  from_status: EventStatus | null;
  to_status: EventStatus;
  actor_id: string | null;
  ngo_id: string | null;
  reason: string | null;
  created_at: Date;
}

/** Item com o contexto que o feed e o detalhe precisam (visão de leitura). */
export interface ItemView extends Item {
  donor_name: string;
  /** URLs públicas, na ordem de envio (a primeira é a capa). */
  photos: string[];
  photo_ids: string[];
  interests_count: number;
  /** O usuário que pediu já curtiu este item. */
  has_user_interest: boolean;
}

export interface Page<T> {
  total: number;
  rows: T[];
}

/** ONG que curtiu um item, como o doador vê na lista de interessadas. */
export interface InterestedNgo {
  interest_id: string;
  ngo_id: string;
  name: string;
  city: string;
  state: string;
  cnpj: string;
  website: string | null;
  ngo_status: NgoStatus;
  liked_at: Date;
}

/** A outra parte de uma negociação. */
export interface Counterpart {
  id: string;
  name: string;
  role: Role;
}

/** Uma linha da lista de conversas. */
export interface ChatSummary {
  item_id: string;
  item_title: string;
  item_status: 'EM_PROGRESSO' | 'DOADO';
  item_photo: string;
  counterpart_id: string;
  counterpart_name: string;
  counterpart_role: Role;
  last_message: string | null;
  last_sender_id: string | null;
  last_created_at: Date | null;
  unread_count: number;
}

export interface UnreadSummary {
  unread_messages: number;
  unread_chats: number;
}

export type ReportStatus = 'ABERTA' | 'RESOLVIDA';

export interface Report {
  id: string;
  item_id: string;
  reporter_id: string;
  reported_id: string;
  reason: string;
  status: ReportStatus;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

/** Uma linha da fila de denúncias do Admin. */
export interface ReportSummary {
  id: string;
  status: ReportStatus;
  reason: string;
  created_at: Date;
  item_id: string;
  item_title: string;
  item_status: ItemStatus;
  reporter_id: string;
  reporter_name: string;
  reporter_role: Role;
  reported_id: string;
  reported_name: string;
  reported_role: Role;
}

/** Parte de uma denúncia, como o Admin vê (com e-mail). */
export interface ReportParty extends Counterpart {
  email: string;
  ngo_profile_id: string | null;
}
