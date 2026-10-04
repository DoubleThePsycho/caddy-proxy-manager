# Proxy host editor

Proxy hosts are created and changed on their own page: **Proxy hosts → New host** (`/proxy-hosts/new`) and **Edit** on a host (`/proxy-hosts/<id>/edit`). **Duplicate** opens a new host that starts as a copy (`/proxy-hosts/new?from=<id>`). The editor is a Community feature.

## Sections

The settings are grouped in six sections. Each has its own address, so a link can open it directly, for example `/proxy-hosts/12/edit#security`.

- **Routing**: domains, upstreams, load balancing with retries and active and passive health checks, WebSockets, the Host header sent upstream, skipping the upstream certificate check, and path-based routes with their own upstreams and load balancing. A new host also asks for its name and tags here.
- **Security**: the WAF mode of the host (global mode, off, detect only or block), whether its rules merge with or override the global ones, the OWASP Core Rule Set, request body limits, custom SecLang directives, the rules excluded on this host, and rate limiting.
- **Access**: the access list, geo blocking, sign-in in front of the host (the built-in sign-in with the users and groups it lets in, Authentik, or Authelia and other forward-auth servers), client certificates (mTLS) and blocked paths.
- **Certificate**: the certificate the host uses (Caddy's own, or one from the Certificates page) and the redirect from HTTP to HTTPS.
- **Headers**: Strict Transport Security.
- **Advanced**: name and tags of an existing host, redirects and rewrites, error pages, upstream name resolution and raw Caddy JSON. Only administrators can change raw Caddy JSON.

Rule exclusions limited to a path or a variable, and path-based mTLS access rules, are listed in their sections but saved on their own: exclusions on the WAF settings page, access rules as soon as they are added, changed or removed.

## Saving

The bar at the bottom counts the unsaved changes against the saved host. **Review changes** (or **Save**, or Ctrl+S) opens the review before anything is saved. It shows:

- each change as before and after, with **Show** to jump to the setting and **Undo** to put it back;
- whether a change approval policy covers the change. Then saving creates a change request instead of applying it: the review says how many approvals it needs, the change window and when it next opens, and asks for a reason for the approvers. Users allowed to make emergency changes can apply it at once with a reason;
- the impact: which host changes, that Caddy reloads and on how many nodes, and the certificates Caddy will request for new domains.

Problems the form can tell on its own, such as an invalid domain or a rate limit window over an hour, are shown next to the field before saving. A problem the server finds is shown next to its field when it names one, otherwise in the review.

Leaving the page with unsaved changes asks first.

## REST API

The editor saves through the same checks as the REST API (`POST /api/v1/proxy-hosts`, `PUT /api/v1/proxy-hosts/{id}`). The review's answer is available to scripts too: send the body of the create or the update to

- `POST /api/v1/proxy-hosts/preview` for a new host,
- `POST /api/v1/proxy-hosts/{id}/preview` for a change.

Both need `proxy_hosts:write`, run the same scope checks as the write and store nothing. The answer holds `approval` (whether a policy covers the change, the policies, the approvals needed, the change window and whether the caller may apply it as an emergency change), `changes` (field by field) and `impact`.

```bash
curl -X POST https://dash.example.com/api/v1/proxy-hosts/12/preview -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"domains": ["app.example.com", "www.example.com"]}'
```

The old address `/proxy-hosts?create=1` (with `&domain=`) still opens a new host.
