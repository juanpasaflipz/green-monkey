ALTER TABLE billing_operations DROP CONSTRAINT billing_operations_kind_check;
ALTER TABLE billing_operations ADD CONSTRAINT billing_operations_kind_check CHECK(kind IN ('customer','trial','checkout','portal','reconcile','checkout_watch','location_quote','location_update','location_watch'));
DROP INDEX billing_one_mutation;
CREATE UNIQUE INDEX billing_one_mutation ON billing_operations(organization_id)
 WHERE kind IN ('customer','trial','checkout','checkout_watch','location_quote','location_update','location_watch') AND state IN ('pending','running','review');
CREATE UNIQUE INDEX billing_location_confirmation ON billing_operations((payload->>'quoteId')) WHERE kind='location_update';
