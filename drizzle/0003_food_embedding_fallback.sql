CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE "compass_health"."food_items"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1024),
  ADD COLUMN IF NOT EXISTS "embedding_text" text,
  ADD COLUMN IF NOT EXISTS "embedding_model" text;

CREATE INDEX IF NOT EXISTS "food_items_embedding_hnsw_idx"
  ON "compass_health"."food_items"
  USING hnsw ("embedding" vector_cosine_ops);
