# Default response

Configure **Settings → General** (Requests for unknown hosts) to preserve Caddy's native behavior for unmatched HTTP requests (such as an automatic HTTPS redirect or empty response, depending on the generated server config), or replace it with:

- a custom HTTP status, body, and response headers (including custom HTML);
- a redirect; or
- an aborted connection with no HTTP response (the Caddy equivalent of an nginx `444`).

Configured proxy hosts always take precedence over this catch-all. For HTTPS, Caddy can only send the response after TLS succeeds; an unknown hostname or direct-IP request may fail the certificate handshake first.

Request placeholders such as `{http.request.uri}` and `{http.request.host}` are expanded in the body, headers and redirect target. Host placeholders (`{env.*}`, `{system.*}`, `{file.*}`) are sent literally, here and in error pages, path-block bodies and redirect rules.
