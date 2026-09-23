-- Same rewrite cycle as 009: organizations' tenant read policy queries
-- restaurants, so restaurants' write policies must not query organizations.
-- Owner commands authorize ownership first and update each tenant under its
-- own transaction-local scope using the existing restaurant_scope policy.
DROP POLICY owner_free_location_update ON restaurants;
