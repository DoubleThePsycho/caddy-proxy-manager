# SAML single sign-on

Source: `ee/saml/` (Elastic License 2.0).

People sign in to the dashboard through a SAML 2.0 identity provider (IdP), such as Microsoft Entra ID, Okta, Google Workspace or Keycloak. Groups the IdP sends can decide their role. One installation can have several providers.

## What it covers

- **Dashboard sign-in only.** The forward-auth portal (`/portal`) is not affected.
- **SP-initiated sign-in only.** Sign-in starts with **Continue with <name>** on the login page. Responses the IdP sends on its own (IdP-initiated, for example from a "My Apps" tile) are refused. Point such tiles at `https://<dashboard>/login` instead.
- **Sessions are created the standard way** (Better Auth's internal adapter), so everything that applies to other sign-ins applies here too:
  - disabled accounts are refused;
  - new accounts get safe defaults (role `user`, status `active`, no custom role) before the group mapping is applied;
  - enforced SSO counts SAML as single sign-on;
  - every sign-in is recorded in the audit log.
- **Not covered:**
  - API tokens. They are separate credentials and keep working.
  - Single logout (SLO). Signing out of the dashboard does not sign out of the IdP, and the reverse.

## How sign-in works

1. **Start.** The login page calls `POST /api/auth/sign-in/saml` with the provider id. The server:
   - stores the AuthnRequest ID together with the SHA-256 of a random binding secret;
   - sets that secret as the `__Host-saml_binding` cookie (`Secure`, `HttpOnly`, `SameSite=None`, 10 minutes);
   - answers with the IdP URL (HTTP-Redirect binding).

   The AuthnRequest asks for a persistent NameID when the provider has no account id attribute. It asks for no particular authentication method, so the IdP's own policy, MFA included, applies. It is signed with RSA-SHA256 when the provider has an SP signing key.
2. **The IdP authenticates the user** and posts a signed response to the provider's assertion consumer service (ACS), `POST /api/auth/saml/acs/{id}`.
3. **The ACS** checks, in this order:
   - **The binding cookie.** It looks up the sign-in this browser started and deletes it: one response per sign-in, whatever the outcome.
   - **The response**, for exactly that sign-in. See [What a response must be](#what-a-response-must-be).
   - **The assertion ID.** It is recorded so that the same assertion never signs in twice.
   - **The account.** It resolves, links or creates the local account and applies the role from the group mapping.

   Only then does it create the session.
4. The browser is redirected to the page the sign-in started from, normally `/`.

The browser never learns why a sign-in failed. Every refusal redirects to `/login?error=saml`, and the login page says that single sign-on did not complete. The reason is recorded in the audit log as `saml_sign_in_refused`, with `data.failure` set to one of:

- the sign-in: `binding`, `idp_initiated`, `in_response_to`, `replayed`, `disabled` (the provider);
- the message: `malformed`, `unsupported`, `status`, `signature`, `algorithm`, `wrapping`;
- its contents: `expired`, `not_yet_valid`, `audience`, `recipient`, `destination`, `issuer`, `subject`, `subject_unusable`;
- the account: `not_provisioned`, `no_email`, `email_in_use`, `privileged_account`, `protected_account`, `already_linked`, `not_in_required_group`, `account_disabled`, `session_refused`, and a few internal failures.

### What a response must be

- **Well-formed SAML 2.0, nothing more.**
  - A `Response` with status `Success` and exactly one `Assertion`, a direct child of the `Response`.
  - No `DOCTYPE` and no encrypted assertion or NameID.
  - XML signatures only directly on the `Response` or the `Assertion`, at most one each, and no two elements with the same ID.
  - These rules refuse the known XML signature wrapping layouts before any signature is checked.
- **Signed by the IdP.**
  - The assertion must be covered by a valid signature from one of the provider's certificates: its own signature, or the response's.
  - Certificates in the message (`KeyInfo`) are never trusted.
  - Every signature must use RSA-SHA256, RSA-SHA512 or RSA-PSS with SHA-256, and SHA-256 or SHA-512 digests. The algorithms are read from the XML and checked before verification, so **SHA-1 is refused whatever the IdP chose**.
- **For this sign-in.**
  - The response's `InResponseTo` must be the ID of the AuthnRequest bound to the browser's cookie.
  - So must the `InResponseTo` of the bearer `SubjectConfirmationData` inside the signed assertion. A captured assertion cannot be re-wrapped into a fresh response.
  - A response without `InResponseTo` is IdP-initiated and refused.
- **For this provider.**
  - `Issuer` (response and assertion) is the IdP's entity ID.
  - `Audience` is the provider's SP entity ID.
  - `SubjectConfirmationData Recipient`, and the response's `Destination`, are the provider's ACS URL. `Destination` is required when the response itself is signed.
- **In time**, with 60 seconds of clock skew:
  - `SubjectConfirmationData NotOnOrAfter` must be present and not passed;
  - `Conditions NotBefore`/`NotOnOrAfter` and `SessionNotOnOrAfter` must hold;
  - `IssueInstant` must not be earlier than the start of the sign-in.

All of these are checked on the bytes the signature covers, never on the posted copy.

## Setting it up

You need the **SAML** page (sidebar) or `/api/v1/saml-providers`, and the `sso:write` permission (administrator-level).

`BASE_URL` must use `https://`. The binding cookie is `Secure` and `SameSite=None`, which browsers accept only over https (and on `http://localhost` for testing). The start of a sign-in is refused with `503 SAML_NEEDS_HTTPS` otherwise, and the SAML page shows a warning.

1. **Add the provider** with a name and the IdP's metadata XML. The metadata is parsed once, when you save. The entity ID, the HTTP-Redirect single sign-on URL and the signing certificates are taken from it, and it is never fetched from a URL. You can also enter the entity ID, the URL and the PEM certificates by hand. Choosing the IdP type fills in the usual attribute names.
2. **Copy the service provider details** to the IdP (the ID card button on the SAML page, or the `sp` object in the API). You can also give the IdP the metadata URL, or download the metadata.

   | Detail | Value |
   | --- | --- |
   | Entity ID (audience, identifier) | `https://<dashboard>/api/auth/saml/metadata/{id}` |
   | ACS URL (reply URL, HTTP-POST) | `https://<dashboard>/api/auth/saml/acs/{id}` |
   | Metadata URL | `https://<dashboard>/api/auth/saml/metadata/{id}` |

   They are derived from `BASE_URL`. Changing `BASE_URL` changes them, and the IdP must be updated too.
3. **Choose the account id.** See [Accounts](#accounts).
4. **Map groups to roles** if the IdP sends groups, and optionally require a group.
5. **Decide about accounts:** create them at first sign-in, link existing ones, or neither.
6. Sign in from a private window to test it. Keep a working local administrator until it works.

### Settings

| Field | Default | What it does |
| --- | --- | --- |
| `name` | | Shown on the login page as **Continue with <name>**. Unique. |
| `enabled` | `true` | Disabled providers are not offered and their responses are refused. |
| `idpMetadataXml` | | Input only. Fills the three fields below unless they are sent too. |
| `idpEntityId` | | The IdP's entity ID: the `Issuer` of its responses. |
| `idpSsoUrl` | | The HTTP-Redirect single sign-on URL. `https://`, or `http://` on the loopback host only. |
| `idpCertificates` | | One to five PEM signing certificates (RSA). Several allow a certificate rollover: responses signed by any of them are accepted. |
| `generateSpKey` / `spPrivateKey` + `spCertificate` | none | Signs AuthnRequests (RSA-SHA256). `generateSpKey: true` creates an RSA-3072 key and a self-signed certificate (10 years). `spPrivateKey: null` removes the key. The key is stored encrypted and never returned. |
| `subjectAttribute` | `null` | Attribute with the immutable account id. `null`: the NameID, which must then be persistent. |
| `emailAttribute` | `email` | The e-mail address of new accounts and of linking. |
| `nameAttribute` | `null` | The display name, updated at every sign-in. |
| `groupsAttribute` | `null` | Needed for `groupRoleMappings` and `requiredGroup`. |
| `groupRoleMappings` | `[]` | `[{"group": "...", "role": "admin" \| "user" \| "viewer"}]`, at most 100. |
| `defaultRole` | `user` | Role of a user in none of the mapped groups: `user` or `viewer`, never `admin`. |
| `requiredGroup` | `null` | Only users with this group can sign in. |
| `provisionUsers` | `false` | Create an account at first sign-in. |
| `linkExistingAccounts` | `false` | Link an existing account with exactly the asserted e-mail address. |

Attribute names are compared exactly, and so are group values (after trimming spaces): Entra ID sends group object IDs, Okta and Keycloak group names.

## Accounts

### The account id

A SAML account is an `accounts` row with provider id `saml:<id>`.

- **Its own namespace.** The colon cannot occur in an OAuth provider id, and `saml:` is neither `credential` nor `ldap:<id>`, so no two sign-in methods share one. Its `accounts.issuer` is `local:saml:<id>`, set by the same account hooks as every other account.
- **The account id is:**
  - the **NameID**, only when its format is `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`. Responses with another NameID format are refused (`subject_unusable`), so a transient or e-mail NameID never becomes an account id;
  - or the value of **`subjectAttribute`**, which must be exactly one value. Use an immutable id: Entra ID's `objectidentifier`, Okta's user id.
- **Never the e-mail address,** unless you set `subjectAttribute` to the e-mail attribute yourself. The SAML page warns about that choice: if the address changes at the IdP, the link breaks, and a new user who gets the old address gets the account.

### Linking and creating accounts

For the first sign-in of an id, in this order:

1. **The linked account.** The account already linked to that id signs in. Its e-mail address is not changed afterwards.
2. **SCIM.** An account that SCIM provisioned, with exactly the asserted e-mail address, is linked when the SCIM settings name this provider as the sign-in provider (see below).
3. **An existing account with exactly the asserted e-mail address** (compared without case, as everywhere) is linked **only when `linkExistingAccounts` is on**. It is never linked, whatever the setting, when it is:
   - the primary admin or a break-glass account;
   - an administrator or a custom-role user (an e-mail match must not hand over privileges);
   - disabled;
   - already linked to another id of this provider.

   With the switch on, whoever controls that address at the IdP can sign in to the account.
4. **A new account,** only when `provisionUsers` is on (off by default, like `AUTH_ALLOW_OAUTH_REGISTRATION` for OAuth) and the assertion has an e-mail address. It gets the address and name exactly as asserted, no username and no password, and is created through Better Auth so that its user hooks run.
5. Otherwise the sign-in is refused.

### Roles

- **The explicit group mapping is the only way SAML grants a role.** No attribute, one named `role` included, is ever read for it, and `AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS` does not apply.
- **With at least one mapping,** every sign-in sets the role: the highest of the matched groups (`admin` > `user` > `viewer`), otherwise `defaultRole`. It demotes as well as promotes, and takes a custom role away.
- **Without mappings,** a new account gets `defaultRole`, and roles are then managed on the Users page.
- **Protected accounts:** the primary admin and break-glass accounts are never changed.
- **The last active administrator** is never demoted. The role is kept and `saml_role_change_skipped` is recorded.
- **When the role is applied:** before the session is created. A sign-in whose role cannot be applied gets no session.

## Enforced SSO, MFA and SCIM

- **Enforced SSO** (`ee/docs/sso-enforcement.md`). SAML sign-in counts as single sign-on: `/saml/acs/:providerId` is one of the session paths enforcement allows. Enabled SAML providers count as identity providers when enforcement is turned on, and they are listed on the SSO page. Password sign-in of the same accounts stays refused.
- **MFA** (`documentation/mfa.md`). It works like OAuth/OIDC sign-in: the IdP is responsible for MFA.
  - An account with MFA turned on is **not** asked for its local code after a SAML sign-in. The local second factor protects that account's password sign-in.
  - The MFA policy covers accounts that can sign in with a password, so an account that signs in only through SAML is not covered.
  - Require MFA at the IdP.
- **SCIM** (`ee/docs/scim.md`). A SAML provider can be the SCIM sign-in provider (`providerId: "saml:<id>"`). Its assertion attributes (first values) stand in for the claims:
  - **Link on a claim** names a SAML attribute that must equal the user's SCIM `externalId`;
  - without one, linking needs **Require a verified e-mail** off, because SAML has no `email_verified`.

## Identity provider setup

In every case:

- use the entity ID and ACS URL from the SAML page;
- sign with RSA-SHA256;
- leave assertion encryption off;
- paste the IdP's metadata XML into the provider.

### Microsoft Entra ID

1. **Create the application.** **Enterprise applications → New application → Create your own application**, "Integrate any other application you don't find in the gallery".
2. **Single sign-on → SAML → Basic SAML Configuration:**
   - **Identifier (Entity ID):** the SP entity ID.
   - **Reply URL:** the ACS URL.
   - **Sign on URL:** `https://<dashboard>/login`.
3. **Attributes & Claims.** Keep the defaults. Entra ID always sends `http://schemas.microsoft.com/identity/claims/objectidentifier`, the immutable object ID.
   - Choose **Microsoft Entra ID** as the IdP type in the provider: the account id attribute is `objectidentifier`, the e-mail attribute is `.../claims/emailaddress`, and the name attribute is `.../claims/displayname`.
   - The default NameID (user principal name, e-mail format) is not used.
4. **Groups (optional).** **Add a group claim**, "Groups assigned to the application", source attribute **Group ID**. The values are group object IDs: map those. Entra ID sends at most 150 groups in a SAML token, so assign only the groups you map.
5. **SAML Certificates.** The default signing option, "Sign SAML assertion" with SHA-256, works. Download **Federation Metadata XML** and paste it into the provider.
6. **Users and groups.** Assign the people who may sign in.

### Okta

1. **Applications → Create App Integration → SAML 2.0.**
2. **Configure SAML:**
   - **Single sign-on URL:** the ACS URL, with "Use this for Recipient URL and Destination URL" checked.
   - **Audience URI (SP Entity ID):** the SP entity ID.
   - **Name ID format:** Unspecified.
   - **Attribute statements:**
     - `userId` = `user.getInternalProperty("id")` (the immutable Okta user id);
     - `email` = `user.email`;
     - `name` = `user.displayName`.
   - **Group attribute statement:** `groups`, with a filter such as "Starts with" `ingressi-`.
3. In the provider, choose **Okta** as the IdP type: the account id attribute is `userId`.
4. **Sign On → SAML Signing Certificates / View SAML setup instructions.** Copy the IdP metadata into the provider. Okta signs with SHA-256 by default.
5. **Assignments.** Assign the people or groups who may sign in.

### Google Workspace

1. **Admin console → Apps → Web and mobile apps → Add app → Add custom SAML app.**
2. **Option 2:** download the IdP metadata and paste it into the provider.
3. **Service provider details:**
   - **ACS URL:** the ACS URL.
   - **Entity ID:** the SP entity ID.
   - **Name ID format:** PERSISTENT.
   - **Name ID:** Basic Information > Primary email.
4. **Attribute mapping:** Primary email → `email`. For groups, under **Group membership**, choose the groups and set the app attribute to `groups`. Google sends the names of the chosen groups.
5. Choose **Google Workspace** as the IdP type: the account id is the persistent NameID.
6. **User access:** turn the app on for the organizational units or groups that may sign in.

Google Workspace offers no immutable user id in SAML. The persistent NameID is the primary e-mail address, so renaming a user's primary address breaks the link: the next sign-in looks like a new identity. If you use employee IDs, map **Employee details > Employee ID** to an attribute and set it as the account id attribute instead.

### Keycloak

1. **Clients → Create client.**
   - **Client type:** SAML.
   - **Client ID:** the SP entity ID.
   - **Valid redirect URIs:** the ACS URL.
2. **Settings:**
   - **Name ID format:** persistent, with **Force name ID format** on. Keycloak then sends a stable pseudonym per user.
   - **Sign documents** and **Sign assertions** on.
   - **Signature algorithm:** RSA_SHA256.
3. **Keys:** turn **Client signature required** off. To sign AuthnRequests instead, generate an SP key in the provider and import its certificate here.
4. **Client scopes → the client's dedicated scope → Add mapper → By configuration:**
   - **User Property** `email`, SAML attribute name `email`;
   - **Group list**, attribute name `groups`, "Full group path" off.
5. **IdP metadata:** `https://<keycloak>/realms/<realm>/protocol/saml/descriptor`. Paste its content into the provider, and choose **Keycloak** as the IdP type.

## REST API

All of these take a Bearer token or a session.

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /api/v1/saml-providers` | `sso:read` | List providers. |
| `POST /api/v1/saml-providers` | `sso:write` | Create a provider. `201`; `409` when the name is taken. |
| `GET /api/v1/saml-providers/{id}` | `sso:read` | One provider. |
| `PUT /api/v1/saml-providers/{id}` | `sso:write` | Change a provider. Fields left out keep their values. |
| `DELETE /api/v1/saml-providers/{id}` | `sso:write` | Delete a provider: its account links, group mappings, sign-ins in progress and replay records are deleted with it (explicitly: the database enforces no foreign keys). The users are kept. |
| `GET /api/v1/saml-providers/{id}/metadata` | `sso:read` | The SP metadata XML. Also public at `GET /api/auth/saml/metadata/{id}`. |

```bash
curl -X POST https://proxy.example.com/api/v1/saml-providers \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "name": "Entra ID",
  "idpMetadataXml": $(jq -Rs . < federationmetadata.xml),
  "subjectAttribute": "http://schemas.microsoft.com/identity/claims/objectidentifier",
  "emailAttribute": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "groupsAttribute": "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  "groupRoleMappings": [{ "group": "6f1d2a3b-0c4e-4b5a-9d8e-7f6a5b4c3d2e", "role": "admin" }],
  "provisionUsers": true
}
JSON
```

**What a provider looks like:**

- everything in the settings table except the SP private key;
- `hasSpPrivateKey` and `signsRequests`;
- `certificates`: subject, validity and SHA-256 fingerprint of each signing certificate;
- `sp` (`entityId`, `acsUrl`, `metadataUrl`);
- `linkedAccounts` and `warnings`.

The OpenAPI reference is under the **SAML Providers** tag.

**Sign-in endpoints (Better Auth, `/api/auth`).** These are the only three:

- `POST /sign-in/saml` `{"providerId": 3, "callbackURL": "/"}`. `callbackURL` must be a path on the dashboard; anything else becomes `/`.
- `POST /saml/acs/{id}`.
- `GET /saml/metadata/{id}`.

No `/api/auth` route registers, lists, changes or deletes providers.

## Security notes

- **Who can set it up.** Provider management needs `sso:write`, which is administrator-level: only administrators can hold it or grant it in a custom role. A provider decides who can sign in and, through its mappings, who becomes an administrator.
- **Secrets.** The SP signing key is encrypted with `SESSION_SECRET` (`encryptSecret`). It is re-encrypted when the secret rotates and never returned. The binding cookie is stored only as a SHA-256 hash.
- **Cross-site POST.** Better Auth's origin check is skipped for `/api/auth/saml/acs/*` only: the IdP posts there cross-site by design. What protects that endpoint:
  - the binding cookie;
  - the AuthnRequest ID bound to it;
  - the signature.

  Without a started sign-in in the same browser, a response is refused before its XML is even parsed.
- **Instance sync.** Providers are per dashboard and **not synced** to slave instances, like users, accounts and OAuth providers. Set them up on the instance people sign in to.

## Audit events

| Action | When |
| --- | --- |
| `saml_provider_created` / `saml_provider_updated` / `saml_provider_deleted` | Provider changes. Certificates are recorded as fingerprints; the SP key never appears. |
| `saml_sign_in_refused` | A refused sign-in. `data.failure` has the reason. |
| `saml_user_provisioned` | An account was created at first sign-in. |
| `saml_account_linked` | An existing account was linked (`data.via`: `email` or `scim`). |
| `saml_role_changed` / `saml_role_change_skipped` | The group mapping changed a role, or could not (last administrator). |
| `login_success` | "User signed in through a SAML provider". |

## Limits and what is not included

- **No IdP-initiated sign-in and no single logout.** Both are deliberate.
- **No encrypted assertions.** TLS protects the response in transit, and the assertion only goes from the IdP to the dashboard through the browser.
- **RSA keys only.** The XML signature library has no ECDSA.
- **AuthnRequests:** HTTP-Redirect binding only. An IdP whose metadata offers only HTTP-POST single sign-on is refused when it is saved.
- **Metadata is a snapshot.** It is not refreshed. Add the IdP's next certificate before it switches (up to five at a time).
- **One sign-in at a time per browser.** Starting a second sign-in replaces the binding cookie, so the first one can no longer complete.
- **Groups:** at most 1000 values per attribute and 200 attributes per assertion; more fails closed.

## Implementation and dependencies

SAML is a Better Auth plugin of Ingressi's own (`ee/saml/plugin.ts`), not `@better-auth/sso`.

- **Signatures** are verified by `@node-saml/node-saml` 5.1.0, on `xml-crypto` 6.3.2. Verification pins the provider's certificates, and the library returns the bytes the signature covers.
- **Everything around the signature** is checked by `ee/saml/response.ts` on those signed bytes: structure, algorithms, issuer, audience, recipient, destination, time, `InResponseTo`, subject confirmation.
- **Versions pinned in `package.json` and `bun.lock`:**
  - `@node-saml/node-saml` 5.1.0;
  - `xml-crypto` 6.3.2;
  - `@xmldom/xmldom` 0.8.15, also used directly for the strict parsing in `ee/saml/xml.ts`.

  `xml-crypto` and `@xmldom/xmldom` are also pinned in `overrides`, so no older copy can enter the tree. These versions include every published advisory fix for xml-crypto and xmldom, as of this release. Through them come `xpath` 0.0.32–0.0.34, `xml2js` 0.6.2, `xml-encryption` 3.1.0 and `xmlbuilder`. `fast-xml-parser` and `samlify` are not in the dependency tree.
- **Unreleased node-saml fixes.** node-saml's repository has fixes after 5.1.0 that are not released yet:
  - responses whose `InResponseTo` is unsigned are trusted;
  - `SubjectConfirmationData NotOnOrAfter` is not enforced in every mode;
  - unsigned input can retire a pending request ID.

  None of them applies here. `InResponseTo` and `NotOnOrAfter` are checked on the signed assertion by `response.ts`. The library's request cache is a read-only view of the one request bound to the browser: it can neither store nor retire requests, and the request is consumed by Ingressi, keyed by the cookie.

## How the former blockers are closed

SAML was held back from an earlier release because of gaps in `@better-auth/sso` 1.7.6, combined with how this install configures Better Auth. Each one is closed, not worked around:

1. **Assertion replay with serial ids.** `@better-auth/sso` reserved assertion IDs in Better Auth's verification table, which relies on string primary keys and silently accepted duplicates with this install's serial ids. Now:
   - Used assertion IDs go to their own table, `saml_used_assertions`, with an explicit unique index on (provider, assertion ID). It keeps each ID until the assertion could no longer be accepted.
   - Each started sign-in can be answered once (`saml_requests` rows are deleted on first use).
   - Neither depends on Better Auth's ID generation. Tests post the same assertion twice, and the same assertion ID inside a second, otherwise valid response.
2. **The response was not bound to the browser (login CSRF).** Now:
   - The `__Host-saml_binding` cookie (`SameSite=None`, `Secure`, `HttpOnly`) is set when the sign-in starts, and only its hash is stored with the AuthnRequest ID.
   - The ACS finds the sign-in by the cookie, consumes it, and requires the response to answer exactly that request.
   - Tests cover a response posted from another browser, an attacker's response forced into a victim's sign-in, and a cookie reused after a failure.
3. **RSA-SHA1 over HTTP-POST.** The signature and digest algorithms of every signature in the message are read from the XML and checked against an allow-list before verification, whatever the binding. Tests cover RSA-SHA1, a SHA-1 digest under RSA-SHA256, and SHA-1 on the response next to a SHA-256 assertion.
4. **`SubjectConfirmationData NotOnOrAfter` and `InResponseTo` were not checked.**
   - A bearer `SubjectConfirmationData` in the signed assertion must have `InResponseTo` equal to this sign-in's request, `Recipient` equal to the ACS URL, and a `NotOnOrAfter` that has not passed.
   - A captured assertion re-wrapped with a fresh `InResponseTo` is refused (tested).
5. **Provider-management routes open to any signed-in user.**
   - `@better-auth/sso` is not used. The plugin has three endpoints (start, ACS, metadata) and no management route.
   - Providers are managed only through `/api/v1/saml-providers` and the dashboard: `sso:write`, administrator-level.
   - A test signs in as a viewer and gets `404` from every `/sso/*` and `/saml/*` management path, and checks that Better Auth exposes no other SAML route.
6. **Account linking worked differently from OAuth.**
   - There is no domain verification and no trust in `email_verified`. Linking is an explicit per-provider switch that mirrors directory sign-in (`ee/ldap/sign-in.ts`): exact e-mail match, never administrators, custom-role users, the primary admin or break-glass accounts.
   - SCIM-provisioned accounts link through `ee/scim/binding.ts`, like OAuth.
   - Accounts are created and linked through Better Auth's internal adapter, so the account and user hooks run.
7. **Role mapping ran after the session existed.** The account is resolved and the role applied before `createSession`. A failure refuses the sign-in with no session left behind.
8. **The `better-auth` version pairing.**
   - Nothing has to match `better-auth`'s version: `@better-auth/sso` is not installed, and the plugin uses only Better Auth's public plugin API and internal adapter, like directory sign-in. `better-auth` stays at 1.7.6.
   - The two advisories against core 1.7.6 (GHSA-965c, magic link with OAuth database state; GHSA-r4xp, OAuth proxy) concern plugins this install does not use.
   - The XML stack's versions are listed above.
