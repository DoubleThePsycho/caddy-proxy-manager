# Search and the command palette

Press **Ctrl+K** (**⌘K** on a Mac) anywhere in the dashboard, or click **Search or jump to…** in the sidebar, to open the command palette. It is a Community feature.

Type part of a name and the palette lists, in this order:

- **Hosts**: proxy hosts by name or domain, and L4 hosts by name or listening address.
- **Certificates** by name or domain, and **Users** by name, e-mail address or username.
- **Actions**: create a proxy host (typing a new domain offers to create a host for it), add an access list, import a certificate, add a user, apply the configuration to Caddy.
- **Go to**: every page of the dashboard you can open.
- **Settings**: each group of the Settings page and the cards it holds (such as DNS-01 providers or the access log), and settings kept elsewhere such as API tokens and WAF settings.
- **Documentation**: these pages and the in-app REST API reference.

With nothing typed, it shows the results you opened last and the most common actions. Use the arrow keys to move, Enter to open, and Escape to clear the search, then again to close the palette. The Settings page also has its own search field, which filters its groups.

## What each user sees

The palette only lists what your role lets you read. Hosts need the proxy host or L4 host read permission and follow your role's tag scope, certificates need the certificates read permission, users need the users read permission, and an action needs the write permission of the page it opens. A user of a client organisation only finds their organisation's hosts, certificates and users. Settings groups need the settings read permission, and instance sync, backups, OAuth providers and certificate storage also need their own.

The results you opened last are kept in your browser, per user, and never sent anywhere. A white-labelled dashboard leaves out the links to this documentation; the REST API reference stays.

## REST API

`GET /api/v1/search?q=` returns the same results. It needs a signed-in session or an API token but no single permission: each group is limited to what the caller can read, as above. The query is matched literally and case-insensitively, and only its first 100 characters are used. An empty query returns suggestions.

```bash
curl -s 'https://dash.example.com/api/v1/search?q=app.example' -H "Authorization: Bearer $TOKEN"
```

```json
{
  "query": "app.example",
  "results": [
    {
      "group": "hosts",
      "kind": "proxy_host",
      "id": "proxy_host:12",
      "title": "app.example.com",
      "subtitle": "Proxy host · App",
      "href": "/proxy-hosts?search=app.example.com",
      "external": false,
      "mono": true,
      "run": null,
      "verb": "Open"
    }
  ]
}
```

`group` is one of `hosts`, `certificates`, `users`, `actions`, `pages`, `settings` and `docs`. `href` is a dashboard path, or for documentation an `https` link (`external` is then true). An action with `run` set to `apply_config` is run by the palette itself (`POST /api/v1/caddy/apply`). User results carry only the name and e-mail address.
