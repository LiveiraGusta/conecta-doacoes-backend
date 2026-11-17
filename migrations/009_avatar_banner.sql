-- 009_avatar_banner.sql — Foto de perfil e banner da ONG (integração com o frontend, fase 0.2b-2)
-- URLs públicas no bucket de itens, pasta profiles/<user_id>/ (avatar 512×512 e banner 1500×500, WEBP).
ALTER TABLE users ADD COLUMN avatar_url TEXT NULL;
ALTER TABLE ngo_profiles ADD COLUMN banner_url TEXT NULL;
