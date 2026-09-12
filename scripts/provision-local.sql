-- Only for the disposable Green Monkey localhost cluster created by local-db.sh.
ALTER ROLE gm_provisioner PASSWORD 'local-only-provisioner';
DO $$ BEGIN
IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='gm_app') THEN
CREATE ROLE gm_app LOGIN PASSWORD 'local-only-green-monkey' NOSUPERUSER NOBYPASSRLS;
END IF;
END $$;
SELECT 'CREATE DATABASE green_monkey_dev OWNER gm_provisioner' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='green_monkey_dev')\gexec
SELECT 'CREATE DATABASE green_monkey_test OWNER gm_provisioner' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='green_monkey_test')\gexec
