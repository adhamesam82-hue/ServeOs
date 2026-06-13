-- Make the tenant_settings RLS policy fail closed without erroring when
-- app.tenant_id is unset. Previously current_setting(..., true) returned ''
-- outside any tenant context, and ''::uuid raised a cast error instead of
-- matching zero rows. nullif(..., '')::uuid yields NULL -> no rows match.
DROP POLICY IF EXISTS tenant_settings_isolation ON "tenant_settings";--> statement-breakpoint
CREATE POLICY tenant_settings_isolation ON "tenant_settings"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);