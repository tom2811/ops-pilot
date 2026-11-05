alter type outbox_status add value if not exists 'skipped';

alter table ticket_attachments
  add column content bytea;
