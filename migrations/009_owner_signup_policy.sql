-- The existing restaurant_scope policy already checks the new restaurant ID
-- against transaction-local tenant scope. The extra INSERT policy queried the
-- organization, whose legacy policy queries restaurants, causing a rewrite cycle.
-- Organization creation itself still requires the authenticated account scope;
-- the signup command creates both records together and never accepts an org ID.
DROP POLICY owner_restaurant_insert ON restaurants;
