-- 0055: aviso temprano de documento ya registrado en la empresa (pedido de Helmer, 2026-11-10, caso CrediLatam).
--
-- El documento es único por empresa (DS-10, `clients_document_key`), pero quien registra un cliente solo VE los
-- clientes de sus rutas. El Cobrador llenaba todo el formulario y al guardar recibía «Ya existe un cliente con
-- ese documento en la empresa», sin saber dónde. Esta consulta le dice, al escribir el documento, si ya existe
-- y en qué RUTA. Solo devuelve el nombre de la ruta y si quien pregunta tiene acceso a ella: nunca los datos
-- del cliente de una ruta ajena.

create function adex.client_document_owner(p_document_type text, p_document text)
  returns table (route_id text, route_name text, accessible boolean)
  language plpgsql stable security definer set search_path = pg_catalog, adex
  as $$
  declare
    v_company text := adex.ctx_company();
    dt        adex.document_types%rowtype;
    norm      text;
  begin
    if v_company is null or not adex.api_scope_ok(v_company) then
      raise exception 'adex: no valid active context' using errcode = '42501';
    end if;
    select * into dt from adex.document_types t
     where t.country_code = adex.company_country(v_company) and t.code = upper(btrim(coalesce(p_document_type, '')));
    if not found then return; end if;
    norm := adex.normalize_document(dt.normalization, p_document);
    if norm is null then return; end if;
    return query
      select c.route_id::text, r.name::text, adex.ctx_route_allowed(c.route_id)
        from adex.clients c join adex.routes r on r.company_id = c.company_id and r.id = c.route_id
       where c.company_id = v_company and c.document_type = dt.code and c.document_normalized = norm
         and not c.document_legacy_duplicate
       limit 1;
  end $$;

revoke all on function adex.client_document_owner(text, text) from public;
grant execute on function adex.client_document_owner(text, text) to adex_api;
