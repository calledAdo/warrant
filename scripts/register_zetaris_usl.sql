-- Warrant's Unified Semantic Layer on Zetaris. Run with: node scripts/setup-usl.mjs
-- ${VAR} placeholders are filled from .env at run time; no credential is written here.

-- Source snapshots in object storage, exactly as pulled from Stripe (test mode) and GitHub.
CREATE LIGHTNING DATABASE warrant_snap DESCRIBE BY "Stripe and GitHub snapshots for Warrant - test data";
CREATE LIGHTNING FILESTORE TABLE stripe_charges FROM warrant_snap FORMAT JSON OPTIONS (
  path "s3a://lotline/warrant/stripe/charges/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);
CREATE LIGHTNING FILESTORE TABLE stripe_customers FROM warrant_snap FORMAT JSON OPTIONS (
  path "s3a://lotline/warrant/stripe/customers/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);
CREATE LIGHTNING FILESTORE TABLE github_incidents FROM warrant_snap FORMAT JSON OPTIONS (
  path "s3a://lotline/warrant/github/incidents/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);

-- Semantic view: candidate duplicate pairs, the same test Warrant's code applies.
-- Same customer, amount and currency, both succeeded and unrefunded, the later within 24 hours,
-- corroborated by a matching non-empty description or a billing incident in the window.
CREATE SCHEMASTORE CONTAINER wr_views;
CREATE SCHEMASTORE VIEW duplicate_candidates WITH CONTAINER wr_views AS
SELECT a.customer_id, a.stripe_charge_id AS kept_charge, b.stripe_charge_id AS candidate_duplicate,
       b.amount, b.currency, a.created_at AS kept_at, b.created_at AS duplicate_at,
       (unix_timestamp(b.created_at) - unix_timestamp(a.created_at)) AS seconds_apart,
       (a.description IS NOT NULL AND a.description <> '' AND a.description = b.description) AS same_description,
       EXISTS (SELECT 1 FROM warrant_db.engineering_incidents i
               WHERE lower(i.title) RLIKE 'billing|charge|payment|invoice|retry'
                 AND i.created_at BETWEEN a.created_at - INTERVAL 1 DAY AND b.created_at + INTERVAL 1 DAY) AS incident_corroborates
FROM warrant_db.billing_history a
JOIN warrant_db.billing_history b
  ON a.customer_id = b.customer_id AND a.amount = b.amount AND a.currency = b.currency
 AND b.created_at > a.created_at AND b.created_at <= a.created_at + INTERVAL 1 DAY
WHERE a.status = 'succeeded' AND b.status = 'succeeded' AND NOT a.refunded AND NOT b.refunded
