-- 0002_demo_flags: viajes y geocercas de demostración identificables y separables de los reales.
ALTER TABLE trips ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE geofences ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX trips_demo ON trips (org_id) WHERE is_demo;
CREATE INDEX geofences_demo ON geofences (org_id) WHERE is_demo;
