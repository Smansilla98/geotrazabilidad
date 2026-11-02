-- Corte del registro de un viaje: duración máxima desde el inicio y margen después de la llegada.
ALTER TABLE trips
  ADD COLUMN max_duration_s int NOT NULL DEFAULT 86400 CHECK (max_duration_s BETWEEN 600 AND 604800),
  ADD COLUMN stop_grace_s   int NOT NULL DEFAULT 600   CHECK (stop_grace_s BETWEEN 0 AND 14400);

-- Captura espaciada para vehículos (un punto cada 2–3 min, envío cada 5 min).
ALTER TYPE tracking_mode ADD VALUE IF NOT EXISTS 'fleet';
