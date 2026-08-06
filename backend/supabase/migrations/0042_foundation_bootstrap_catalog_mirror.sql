-- Keep the registered consumer contract aligned with the closed catalog that
-- the Foundation bootstrap reconciler can actually apply after a cold boot.
-- The OTEL operand is mirrored into the official OpenSphere GHCR namespace;
-- its upstream digest is preserved and remains immutable.

do $$
declare
  updated_count integer;
begin
  update console.consumer_contract
     set metadata = jsonb_set(
                      jsonb_set(
                        coalesce(metadata, '{}'::jsonb),
                        '{catalogVersion}',
                        to_jsonb('20260801.1'::text),
                        true
                      ),
                      '{catalogSha256}',
                      to_jsonb('619c32c6d461bb79b4f1e80b1d58a9b03b1f93af8c238bf66f002e2661569690'::text),
                      true
                    ),
         updated_at = clock_timestamp()
   where consumer_id = 'foundation-bootstrap';

  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'foundation-bootstrap consumer contract update expected 1 row, got %', updated_count;
  end if;
end
$$;
