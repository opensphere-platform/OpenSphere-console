\set ON_ERROR_STOP on

-- One polymorphic trigger function protects both resource_node and
-- resource_relation. Only resource_node owns stream_sequence, so direct record
-- field access is invalid when PostgreSQL invokes the relation trigger.
CREATE OR REPLACE FUNCTION oaa.assert_graph_monotonicity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, oaa AS $$
BEGIN
  IF NEW.fencing_epoch < OLD.fencing_epoch
     OR (NEW.fencing_epoch = OLD.fencing_epoch AND NEW.collection_epoch < OLD.collection_epoch)
     OR (TG_TABLE_NAME = 'resource_node'
         AND NEW.fencing_epoch = OLD.fencing_epoch
         AND NEW.collection_epoch = OLD.collection_epoch
         AND coalesce((to_jsonb(NEW)->>'stream_sequence')::bigint, -1)
             < coalesce((to_jsonb(OLD)->>'stream_sequence')::bigint, -1)) THEN
    RAISE EXCEPTION 'operational graph revision regression' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION oaa.assert_graph_monotonicity()
  IS 'Monotonic fencing/collection guard shared safely by node and relation row types.';
