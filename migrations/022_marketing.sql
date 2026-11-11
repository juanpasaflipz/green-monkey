-- Guest records, consent evidence, campaigns, automations and a durable message
-- outbox. Consent is append-only evidence; the booleans on guests are the
-- current state derived from it in the same transaction.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gm_marketing_worker') THEN
  CREATE ROLE gm_marketing_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;

CREATE TABLE guests(
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 id uuid NOT NULL,
 name text NOT NULL DEFAULT '' CHECK(length(name)<=80),
 email text CHECK(email=lower(email) AND length(email) BETWEEN 3 AND 254),
 phone text CHECK(phone ~ '^\+[1-9][0-9]{7,14}$'),
 locale text NOT NULL DEFAULT 'es' CHECK(locale IN ('es','en')),
 email_opt_in boolean NOT NULL DEFAULT false,
 sms_opt_in boolean NOT NULL DEFAULT false,
 whatsapp_opt_in boolean NOT NULL DEFAULT false,
 first_consent_at timestamptz,
 source text NOT NULL CHECK(source IN ('pos','qr','kiosk','manager','import')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 CHECK(email IS NOT NULL OR phone IS NOT NULL),
 CHECK(NOT email_opt_in OR email IS NOT NULL),
 CHECK(NOT (sms_opt_in OR whatsapp_opt_in) OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX guest_email ON guests(tenant_id,email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX guest_phone ON guests(tenant_id,phone) WHERE phone IS NOT NULL;

CREATE TABLE guest_consents(
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 guest_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel IN ('email','sms','whatsapp')),
 granted boolean NOT NULL,
 source text NOT NULL CHECK(source IN ('pos','qr','kiosk','manager','import','unsubscribe_link','provider')),
 wording text NOT NULL DEFAULT '',
 actor_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,guest_id) REFERENCES guests(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES employees(tenant_id,id)
);
CREATE INDEX guest_consent_history ON guest_consents(tenant_id,guest_id,created_at);

ALTER TABLE orders ADD COLUMN guest_id uuid;
ALTER TABLE orders ADD CONSTRAINT orders_guest FOREIGN KEY(tenant_id,guest_id) REFERENCES guests(tenant_id,id);
CREATE INDEX order_guest ON orders(tenant_id,guest_id,created_at) WHERE guest_id IS NOT NULL;

CREATE TABLE order_feedback(
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=500),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);

CREATE TABLE marketing_settings(
 tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
 version integer NOT NULL DEFAULT 1,
 sender_name text NOT NULL DEFAULT '' CHECK(length(sender_name)<=60),
 reply_to text CHECK(length(reply_to)<=254),
 privacy_url text CHECK(privacy_url ~ '^https://' AND length(privacy_url)<=300),
 review_url text CHECK(review_url ~ '^https://' AND length(review_url)<=300),
 frequency_cap_days integer NOT NULL DEFAULT 30 CHECK(frequency_cap_days BETWEEN 1 AND 365),
 attribution_days integer NOT NULL DEFAULT 7 CHECK(attribution_days BETWEEN 1 AND 30),
 send_hour integer NOT NULL DEFAULT 11 CHECK(send_hour BETWEEN 8 AND 20),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns(
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1,
 kind text NOT NULL CHECK(kind IN ('one_off','automation')),
 automation_key text CHECK(automation_key IN ('welcome','positive_feedback','big_spender','repeat_guest','miss_you','first_online_order','drive_in_store','follow_up')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 channels text[] NOT NULL CHECK(cardinality(channels) BETWEEN 1 AND 3 AND channels <@ ARRAY['email','sms','whatsapp']),
 subject text NOT NULL DEFAULT '' CHECK(length(subject)<=120),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 segment jsonb NOT NULL DEFAULT '{}',
 params jsonb NOT NULL DEFAULT '{}',
 promotion_id uuid,
 state text NOT NULL CHECK(state IN ('draft','scheduled','sending','sent','cancelled','active','paused')),
 scheduled_at timestamptz,
 launched_at timestamptz,
 audience integer,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,promotion_id) REFERENCES promotions(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES employees(tenant_id,id),
 CHECK((kind='automation')=(automation_key IS NOT NULL)),
 CHECK(kind<>'automation' OR state IN ('active','paused')),
 CHECK(kind<>'one_off' OR state NOT IN ('active','paused'))
);
CREATE UNIQUE INDEX campaign_automation ON campaigns(tenant_id,automation_key) WHERE automation_key IS NOT NULL;
CREATE INDEX campaign_due ON campaigns(scheduled_at) WHERE state='scheduled';

CREATE TABLE messages(
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 campaign_id uuid NOT NULL,
 guest_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel IN ('email','sms','whatsapp')),
 to_address text NOT NULL,
 subject text NOT NULL DEFAULT '',
 body text NOT NULL,
 dedupe_key text NOT NULL,
 automated boolean NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','failed','suppressed','uncertain')),
 attempts integer NOT NULL DEFAULT 0,
 next_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 lease_token uuid,
 provider_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,dedupe_key),
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id),
 FOREIGN KEY(tenant_id,guest_id) REFERENCES guests(tenant_id,id)
);
CREATE INDEX message_due ON messages(next_at) WHERE state IN ('queued','sending');
CREATE INDEX message_guest ON messages(tenant_id,guest_id,created_at);
CREATE INDEX message_campaign ON messages(tenant_id,campaign_id);

-- One automation evaluation per restaurant per local calendar day.
CREATE TABLE marketing_runs(
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 local_date date NOT NULL,
 window_start timestamptz NOT NULL,
 window_end timestamptz NOT NULL,
 queued integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,local_date),
 CHECK(window_start<window_end)
);

CREATE TABLE social_posts(
 tenant_id uuid NOT NULL REFERENCES restaurants(id),
 id uuid NOT NULL,
 network text NOT NULL CHECK(network IN ('instagram','facebook','tiktok','google')),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2200),
 planned_for date,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','posted','discarded')),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES employees(tenant_id,id)
);

DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['guests','guest_consents','order_feedback','marketing_settings','campaigns','messages','marketing_runs','social_posts'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
END LOOP;
END $$;

-- The marketing worker may enumerate restaurants and find due work; everything
-- else it touches is still scoped by app.tenant_id like the application role.
-- The discovery policies apply only while no tenant is selected, so a tenant
-- transaction of the worker can never read another restaurant's rows.
CREATE POLICY marketing_worker_restaurants ON restaurants FOR SELECT TO gm_marketing_worker
 USING(nullif(current_setting('app.tenant_id',true),'') IS NULL);
CREATE POLICY marketing_worker_due ON messages FOR SELECT TO gm_marketing_worker
 USING(state IN ('queued','sending') AND nullif(current_setting('app.tenant_id',true),'') IS NULL);
CREATE POLICY marketing_worker_planned ON campaigns FOR SELECT TO gm_marketing_worker
 USING(state IN ('scheduled','sending','active') AND nullif(current_setting('app.tenant_id',true),'') IS NULL);
GRANT USAGE ON SCHEMA public TO gm_marketing_worker;
GRANT SELECT(id,name,timezone,currency) ON restaurants TO gm_marketing_worker;
-- Evaluated by the owner policy on restaurants; its own row security still
-- hides every membership row from the worker.
GRANT SELECT ON owner_memberships TO gm_marketing_worker;
GRANT SELECT ON restaurant_entitlements,guests,orders,order_feedback,promotions,marketing_settings TO gm_marketing_worker;
GRANT SELECT,INSERT ON marketing_runs,messages TO gm_marketing_worker;
GRANT UPDATE(state,attempts,next_at,lease_until,lease_token,provider_id,error_code,sent_at) ON messages TO gm_marketing_worker;
GRANT SELECT ON campaigns TO gm_marketing_worker;
GRANT UPDATE(state,launched_at,audience) ON campaigns TO gm_marketing_worker;
