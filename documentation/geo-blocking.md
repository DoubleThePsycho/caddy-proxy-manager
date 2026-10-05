# Geo blocking

Geo blocking is configured per proxy host. It requires MaxMind GeoLite2 databases (see [GeoIP setup](#geoip-setup)).

It also has a fail-closed mode, custom response codes and bodies, and trusted proxy support. The defaults for every host are under **Settings → Geo blocking and GeoIP** ([settings.md](settings.md)), and L4 proxy hosts have geo blocking of their own. [Access lists](access-lists.md) can allow or deny by country, continent and AS number too.

## Rule types

| Type | Example | Description |
|------|---------|-------------|
| Country | `DE` | ISO 3166-1 alpha-2 country code |
| Continent | `EU` | `AF`, `AN`, `AS`, `EU`, `NA`, `OC`, `SA` |
| ASN | `64496` | Autonomous System Number |
| CIDR | `203.0.113.0/24` | IP range in CIDR notation |
| IP | `203.0.113.10` | Exact IP address |

Rules can be **block** or **allow**. Allow rules take precedence over block rules — you can block an entire continent and then allow specific IPs or ASNs through.

## GeoIP setup

Geo blocking requires MaxMind GeoLite2 Country and/or ASN databases. Use the bundled `geoipupdate` service:

1. Register for a free MaxMind account at [maxmind.com](https://www.maxmind.com/)
2. Generate a license key with `GeoLite2-Country` and `GeoLite2-ASN` permissions
3. Add to your `.env`:
   ```
   GEOIPUPDATE_ACCOUNT_ID=your-account-id
   GEOIPUPDATE_LICENSE_KEY=your-license-key
   ```
4. Start with the `geoipupdate` profile:
   ```bash
   docker compose --profile geoipupdate up -d
   ```

The databases are stored in the `geoip-data` Docker volume and shared between the web and Caddy containers.
