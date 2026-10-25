-- Warrant Zetaris principals: least-privilege read-only access to evidence tables
-- Run after datasource registration

-- Evidence principal: can read billing_history and engineering_incidents
ADD USER WITH (name 'warrant_evidence', email '${ZETARIS_WR_EVIDENCE_USER}', password '${ZETARIS_WR_EVIDENCE_PASSWORD}');
CREATE ROLE 'warrant_evidence' DESCRIBE BY 'Warrant evidence read-only access';
ASSIGN USER '${ZETARIS_WR_EVIDENCE_USER}' TO ROLE 'warrant_evidence';
GRANT SELECT ON DATASOURCE TABLE warrant_db.billing_history TO ROLE 'warrant_evidence';
GRANT SELECT ON DATASOURCE TABLE warrant_db.engineering_incidents TO ROLE 'warrant_evidence';

-- History principal: can read case_history for precedent retrieval
ADD USER WITH (name 'warrant_history', email '${ZETARIS_WR_HISTORY_USER}', password '${ZETARIS_WR_HISTORY_PASSWORD}');
CREATE ROLE 'warrant_history' DESCRIBE BY 'Warrant case history read-only access';
ASSIGN USER '${ZETARIS_WR_HISTORY_USER}' TO ROLE 'warrant_history';
GRANT SELECT ON DATASOURCE TABLE warrant_db.case_history TO ROLE 'warrant_history';
