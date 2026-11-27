-- Execute no SQL Editor do Supabase antes de iniciar o serviço no Render.
create table if not exists public.whatsapp_auth_state (
  session_id text not null,
  key text not null,
  value jsonb not null,
  primary key (session_id, key)
);
alter table public.whatsapp_auth_state enable row level security;
revoke all on public.whatsapp_auth_state from anon, authenticated;
