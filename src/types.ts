// Tipos de domínio: iguais às linhas do banco (snake_case), sem lógica.

export type Role = 'DONOR' | 'NGO' | 'ADMIN';
export type NgoStatus = 'PENDENTE_APROVACAO' | 'ATIVO' | 'REJEITADO';
export type Category = 'ROUPAS' | 'BRINQUEDOS' | 'ALIMENTOS' | 'LIVROS';
export type ItemStatus = 'DISPONIVEL' | 'EM_PROGRESSO' | 'DOADO';
/** Status que aparece em item_events (CANCELADO nunca fica gravado em items.status). */
export type EventStatus = ItemStatus | 'CANCELADO';
/** Moderação do anúncio, independente do status da doação. */
export type ModerationStatus = 'VISIVEL' | 'OCULTO' | 'REMOVIDO';
export type ThemeColor = 'AZUL' | 'VERDE' | 'ROXO' | 'LARANJA' | 'ROSA';
export type ThemeMode = 'LIGHT' | 'DARK' | 'SYSTEM';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  city: string;
  state: string;
  /** Descrição da página pessoal (até 500). */
  bio?: string | null;
  /** URL pública da foto de perfil (512×512). */
  avatar_url?: string | null;
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
  /** URL pública do banner (1500×500). */
  banner_url?: string | null;
  /** Só dígitos, com DDD (10 ou 11). */
  phone?: string | null;
  /** Usuário do Instagram, sem @. */
  instagram?: string | null;
  accepted_categories?: Category[];
  /** Endereço: todos nulos ou todos preenchidos (o complemento é opcional). */
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
}

export interface UserPreferences {
  theme_color: ThemeColor;
  theme_mode: ThemeMode;
  show_donations: boolean;
}

/** Usuário com o perfil de ONG (quando role = NGO) e as preferências (null = padrões). */
export interface UserWithProfile extends User {
  ngo_profile: NgoProfile | null;
  preferences?: UserPreferences | null;
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
  moderation_status: ModerationStatus;
  /** Motivo da remoção pelo Admin (mostrado ao doador). */
  moderation_reason: string | null;
  moderated_at?: Date | null;
  moderated_by?: string | null;
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
  donor_avatar_url: string | null;
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
  avatar_url: string | null;
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
  avatar_url?: string | null;
}

/** Linha da página pessoal (GET /users/:id): usuário, perfil de ONG, privacidade e contagem. */
export interface UserProfileRow {
  id: string;
  name: string;
  role: Role;
  city: string;
  state: string;
  bio: string | null;
  avatar_url: string | null;
  created_at: Date;
  ngo_status: NgoStatus | null;
  website: string | null;
  banner_url: string | null;
  phone: string | null;
  instagram: string | null;
  accepted_categories: Category[];
  cep: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  show_donations: boolean;
  donations_count: number;
}

/** O que a página pessoal mostra para quem está logado. */
export interface UserProfileView {
  row: UserProfileRow;
  /** Doador com as doações ocultas (e quem vê não é ele): a contagem não aparece. */
  donationsHidden: boolean;
  /** Endereço e contatos só de ONG ATIVO, salvo para a própria ONG. */
  showNgoContact: boolean;
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
  counterpart_avatar_url: string | null;
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
/** CHAT: a outra parte da negociação. ITEM: o conteúdo do anúncio. */
export type ReportKind = 'CHAT' | 'ITEM';
export type ReportCategory = 'NUDEZ' | 'ODIO' | 'VIOLENCIA' | 'GOLPE' | 'PROIBIDO' | 'SPAM' | 'OUTRO';
export type ReportResolution = 'ITEM_REMOVIDO' | 'IMPROCEDENTE';

export interface Report {
  id: string;
  item_id: string;
  reporter_id: string;
  reported_id: string;
  kind: ReportKind;
  /** Só nas denúncias de anúncio. */
  category: ReportCategory | null;
  /** Obrigatório no CHAT; opcional no ITEM (salvo na categoria OUTRO). */
  reason: string | null;
  status: ReportStatus;
  resolution: ReportResolution | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

/** Uma linha da fila de denúncias do Admin. */
export interface ReportSummary {
  id: string;
  kind: ReportKind;
  category: ReportCategory | null;
  status: ReportStatus;
  resolution: ReportResolution | null;
  reason: string | null;
  created_at: Date;
  item_id: string;
  item_title: string;
  item_status: ItemStatus;
  item_moderation_status: ModerationStatus;
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

/** Denúncia de anúncio com o nome de quem denunciou (detalhe do Admin). */
export interface ItemReportRow {
  id: string;
  category: ReportCategory;
  reason: string | null;
  status: ReportStatus;
  created_at: Date;
  reporter_id: string;
  reporter_name: string;
  reporter_role: Role;
}
