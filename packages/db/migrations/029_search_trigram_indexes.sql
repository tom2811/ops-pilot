-- Enable pg_trgm for accelerated substring (ILIKE) search
create extension if not exists pg_trgm;

-- Drop the unused tsvector GIN index that ILIKE cannot use
drop index if exists tickets_search_idx;

-- Trigram GIN indexes for fast substring matching on tickets and users
create index if not exists tickets_subject_trgm_idx on tickets using gin (subject gin_trgm_ops);
create index if not exists tickets_description_trgm_idx on tickets using gin (coalesce(description, '') gin_trgm_ops);
create index if not exists users_display_name_trgm_idx on users using gin (display_name gin_trgm_ops);
