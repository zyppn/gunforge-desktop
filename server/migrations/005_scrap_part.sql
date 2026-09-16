-- ============================================================
-- 005: scrap_part — make scrapping actually delete the part
--
-- doTrash() credited the player and spliced the part out of the local array,
-- but never touched the parts table, so the row returned on the next cloud
-- load. Scrap -> restart -> scrap again was unlimited credits. Scrapping now
-- goes through this RPC: delete and credit in one transaction, or neither.
--
-- Credit values mirror RAR[].scrap in renderer/index.html.
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

create or replace function scrap_part(p_part uuid) returns int
language plpgsql security definer as $$
declare v_owner uuid; v_rar text; v_credits int;
begin
  select owner_id, rarity into v_owner, v_rar
    from parts where uid = p_part and not equipped for update;
  if v_owner is null then raise exception 'part not found or equipped'; end if;
  if v_owner <> (select id from players where auth_uid = auth.uid()) then
    raise exception 'not your part';
  end if;
  if exists (select 1 from listings where part_uid = p_part and status = 'active') then
    raise exception 'part is listed - cancel the listing first';
  end if;
  v_credits := case v_rar
    when 'common'    then 5
    when 'uncommon'  then 12
    when 'rare'      then 30
    when 'epic'      then 75
    when 'legendary' then 200
    else 5 end;
  delete from parts where uid = p_part;
  update players set credits = credits + v_credits where id = v_owner;
  return v_credits;
end $$;

notify pgrst, 'reload schema';
