# White-label

Source: `ee/white-label/` (Elastic License 2.0).

White-label puts your own brand on the dashboard and on every sign-in page. Your users see your product name, logo, colours and support contact instead of the product's own.

## What it changes

| Setting | Where it shows |
| --- | --- |
| Product name | Browser titles, the dashboard sidebar and mobile header, the sign-in, MFA setup and forward-auth portal pages, the API consumer portal, the API docs title, alert and digest e-mails (`[Name]` subject prefix, "Sent by Name"), Slack/Teams/ntfy/PagerDuty messages, new authenticator app entries, and messages in the dashboard that name the product. |
| Logo (light theme), logo (dark theme) | The sign-in page, the forward-auth portal, the API consumer portal and the dashboard sidebar. With one logo it is used in both themes. |
| Favicon | Every page. |
| Accent colour, with an optional dark-theme colour | Buttons, links, focus rings and highlights, through the theme's `--primary`, `--primary-foreground` and `--ring` variables. |
| Sign-in heading, sign-in footer | The sign-in page and the forward-auth portal (the footer also on the API consumer portal). |
| Support URL, support e-mail | Under the sign-in forms and at the bottom of the dashboard sidebar. |
| E-mail sender name | The display name in the From header of alert and digest e-mails, in front of each channel's own address. Empty: the bare address, as before. |
| "Powered by" note | A small note naming the real product under the sign-in forms and in the sidebar. Shown by default once a name or logo of your own is set; it can be turned off. |

The forward-auth portal (`/portal`) is the page your users see most: it shows the logo (or the sign-in heading when there is no logo), the footer, the support contact and the note.

### What keeps the real name

- The notices required by the MIT and Elastic licenses.
- Identifiers: HTTP header names (`X-Ingressi-*` and the forward-auth headers), the webhook `source` field, PagerDuty dedup keys, syslog app names, User-Agent strings, cookie, image and volume names, environment variables and file names.
- The CA name of client-certificate authorities created in the dashboard, and the instructions sent to the AI model.
- Authenticator app entries made before the change keep the name they were created with.

## Setup

1. Open **Branding** in the sidebar.
2. Fill in the fields you want; leave a field empty to keep the default. The preview shows the sign-in page in both themes as you type.
3. Upload the logos and the favicon. Each upload is stored at once.
4. **Save** the text fields and colours.

Pages pick the change up on the next load. **Reset to defaults** removes everything, images included.

## Rules

- **Product name** up to 60 characters, **sign-in heading** 100, **footer** 500 (line breaks are kept), **sender name** 80. Control characters and invisible formatting characters (bidi overrides, zero-width characters) are refused, so a name cannot be disguised as another one. Everything is shown as plain text, never as HTML.
- **Colours** are `#rgb` or `#rrggbb`, stored as lowercase `#rrggbb`. The light colour needs 3:1 contrast with the light background (white) and the dark colour 3:1 with the dark background (`#18181b`); the error message gives the ratio. Text on the accent is black or white, whichever contrasts more, which is always at least 4.5:1. Without a dark colour one is derived: the light colour when it contrasts enough, otherwise the light colour mixed with white until it does.
- **Support URL** must be `http://` or `https://` without a user name or password; **support e-mail** must be an address.
- **Images:**

| Image | Types | Size |
| --- | --- | --- |
| Logos | PNG, JPEG, WebP | up to 2048×2048 |
| Favicon | PNG, ICO, WebP, JPEG | up to 512×512 (ICO images up to 256×256) |

Every file is at most 512 KB.

## REST API

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/branding` | `branding:read` | Settings, effective values, images, limits, and `source` (`default`, `local`, `master`). |
| `PUT /api/v1/branding` | `branding:write` | Partial update: fields left out keep their values; `null` or `""` restores the default; unknown fields are refused. |
| `DELETE /api/v1/branding` | `branding:write` | Resets everything, images included. |
| `PUT /api/v1/branding/assets/{asset}` | `branding:write` | `logo-light`, `logo-dark` or `favicon`: multipart/form-data with a `file` field, or the image as the body. `413` above 512 KB. |
| `DELETE /api/v1/branding/assets/{asset}` | `branding:write` | Removes an image. |
| `GET /api/branding/{asset}` | public | Serves an image (see below). |

```bash
curl -X PUT https://proxy.example.com/api/v1/branding \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"productName": "Example Edge", "accentColor": "#1d4ed8", "supportEmail": "help@example.com"}'

curl -X PUT https://proxy.example.com/api/v1/branding/assets/logo-light \
  -H "Authorization: Bearer $TOKEN" -F file=@logo.png

curl -X PUT https://proxy.example.com/api/v1/branding/assets/favicon \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/x-icon" --data-binary @favicon.ico
```

Every change is audited: `branding_updated` (the fields changed, with old and new values), `branding_asset_uploaded`, `branding_asset_deleted`, `branding_reset`.

## Permissions

The `branding` area has `read` and `write`. `branding:write` is **administrator-level**: only administrators can grant it. Whoever holds it chooses the name and logo every sign-in page of the install shows, including the forward-auth portal of every protected site, so it could be used to make those pages look like another organisation's.

## Instance sync

The branding, images included, is part of instance sync (`white_label` in the sync payload), because slaves serve the forward-auth portal and the sign-in pages too. A slave shows the master's branding unless it has its own; resetting on the slave brings the master's back. It is not part of configuration export, history or backups, which cover what Caddy serves.

## Security notes

- **Images are recognised by their content**, not by the file name or the declared type. A name or type that contradicts the content is refused, and so is anything that says SVG.
- **No SVG.** An SVG is a document that can run script.
- **Each image is parsed and written out again** with only what a browser needs to draw it: nothing may follow the end of the image (so HTML, ZIP or anything else appended to a valid image is refused), PNG text and private chunks, JPEG comments and EXIF/XMP segments, and WebP EXIF/XMP chunks are removed, and a file containing HTML or script anywhere (`<script`, `<svg`, `<!doctype`, `javascript:` and similar) is refused. Polyglot files that are both an image and a document are therefore never stored.
- **Serving:** `GET /api/branding/{asset}` sends the stored type as `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`. URLs carry a version (`?v=`, a hash of the image): with the current version the answer may be cached for a year, otherwise it is revalidated, so a new upload shows at once.
- **Colours** reach the style sheet only as validated six-digit hex values, so they cannot inject CSS.
- **Stored values are checked again on every read**, including the copy a slave receives from its master; a field that does not pass falls back to its default.
- The parsed branding is cached in memory and dropped when it changes on this instance or a sync payload arrives; each read also compares the row's update time, so changes made any other way are picked up.

## Limits

- One branding per install: there is no per-host branding.
- The custom domain of the dashboard is set up as usual (a proxy host or `BASE_URL`), not here.
- The product name in e-mails applies to messages sent after the change.
