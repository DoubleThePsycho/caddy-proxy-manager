-- How the sign-in that created a dashboard session was made (password, sso,
-- saml, ldap or passkey). The forward-auth portal reuses a dashboard session
-- only when it came from an identity provider (sso, saml, ldap). Sessions
-- that exist before this migration have none, so they are not reused.
ALTER TABLE `sessions` ADD `signInMethod` text;
