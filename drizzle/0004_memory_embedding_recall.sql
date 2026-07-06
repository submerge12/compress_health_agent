CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE "compass_health"."memory_records"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1024),
  ADD COLUMN IF NOT EXISTS "embedding_model" text;

CREATE INDEX IF NOT EXISTS "memory_records_embedding_hnsw_idx"
  ON "compass_health"."memory_records"
  USING hnsw ("embedding" vector_cosine_ops);
