-- 0003_refresh_rotation: distingue token rotado (replaced_at; admite un margen corto de reintento)
-- de token revocado (revoked_at; logout, reset de contraseña, revocación de dispositivo o robo detectado).
ALTER TABLE refresh_tokens ADD COLUMN replaced_at timestamptz;
