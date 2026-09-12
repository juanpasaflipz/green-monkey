GRANT CONNECT ON DATABASE green_monkey_dev TO gm_app;
GRANT USAGE ON SCHEMA public TO gm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO gm_app;
GRANT INSERT,UPDATE ON employees,devices,sessions,catalog,dining_tables,order_numbers,orders,rounds,cash_sessions,stock_items,jobs TO gm_app;
GRANT INSERT ON order_lines,tenders,refunds,cash_movements,stock_movements,audit,operations,import_batches,source_mappings,expenses TO gm_app;

GRANT INSERT ON recipe_versions,receipts TO gm_app;
GRANT INSERT,UPDATE ON suppliers,shifts TO gm_app;
