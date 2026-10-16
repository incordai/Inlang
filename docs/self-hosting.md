# Self-hosting — the built-in backend on your own server

az lets a site's owner choose where accounts and data live:

- **Self-hosted** — this page: the backend az generates (backend-spec), on a
  server you run, with the database you choose.
- **Cloud** — a managed project runs the database and sign-in for you. See
  [cloud-setup.md](cloud-setup.md).

Everything below is also described, with its reasons and tests, in
[backend-spec.md](backend-spec.md); this page is the order to do it in.

## 1. Declare it

```
site studio
  auth
    adapter azbackend
  backend
    database postgres        # sqlite | postgres | mysql
    email    smtp            # smtp | api
```

Only choices go in the `.az` file. Addresses, passwords and keys go in the
server's `.env` — the compiler refuses a connection string written here.

## 2. Try it locally first

```
az dev site.az --open
```

Site, backend (SQLite in `.az-dev/`), and a local mailbox for reset and
sign-in emails, with nothing to configure (backend-spec §2a).

## 3. Build

```
AZ_PUBLIC_BACKEND_URL=https://api.example.org az build site.az --out out
```

`out/` is the site (deploy `out/dist/` after `npm install && npm run build`
there, or let your host build it); `out/server/` is the backend.

## 4. Configure the server

```
az backend init out/server
```

writes `out/server/.env` with a fresh session secret (mode `0600`; it never
overwrites an existing one). Fill in the rest — `.env.example` beside it lists
every key the chosen setup reads:

| For | Keys |
|---|---|
| always | `AZ_BACKEND_PUBLIC_URL`, `AZ_ALLOWED_ORIGINS` (the site's exact origin), `AZ_EMAIL_FROM` |
| SQLite | `AZ_SQLITE_PATH` (default `./data/app.db`; keep it on a persistent disk and back it up) |
| PostgreSQL / MySQL | `AZ_DATABASE_URL`, `AZ_DATABASE_TLS=require` off-host, `AZ_DATABASE_CA_FILE` if the host signs with its own certificate |
| SMTP | `AZ_SMTP_HOST`, `AZ_SMTP_PORT`, `AZ_SMTP_USER`, `AZ_SMTP_PASSWORD` |
| email API | `AZ_EMAIL_API_URL`, `AZ_EMAIL_API_KEY` |
| social sign-in | `AZ_OAUTH_PROVIDERS`, then per provider `AZ_OAUTH_<ID>_LABEL`, `_TYPE` (oidc / oauth2), `_ISSUER` or the three URLs, `_CLIENT_ID`, `_CLIENT_SECRET` |

The server checks all of it at start and **refuses to start**, naming every
missing or unsafe key at once. None of these keys ever reaches the site: only
`AZ_PUBLIC_` variables are inlined into a site build, and the build fails if
a server secret is given a public name.

## 5. Choose the database

| Database | When | Notes |
|---|---|---|
| SQLite | one server, modest traffic | a file on the server's disk; nothing else to run |
| PostgreSQL | the data should live on a separate or managed database server, or you already run it | a managed PostgreSQL works too, pooled or direct (backend-spec §3.1) |
| MySQL | you already run it | 8.4 tested |

Migrations run on every start and are safe to repeat.

## 6. Run it

- **Node 22** on the server; in `out/server/`, `npm install` (only the driver
  your setup needs) then `npm start`.
- **On Linux with glibc** (Debian, Ubuntu, Red Hat) and image fields or chat
  images: glibc's default allocator holds on to memory freed by the image
  library, so a busy server's memory creeps up. The image library's own
  install guide recommends an alternative allocator such as jemalloc
  (preload it, e.g. `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2`).
  If you cannot, start the server with `MALLOC_ARENA_MAX=2`, which limits the
  same effect. Alpine (musl) and macOS are not affected.
- **Behind TLS**, on the **same site** as the pages (`api.example.org` beside
  `www.example.org`): the session cookie is then `SameSite=Lax`. A different
  site needs `AZ_COOKIE_SAMESITE=none`, which some browsers restrict.
- Behind reverse proxies you control, set `AZ_TRUST_PROXY` to how many of them
  append to `X-Forwarded-For` (`true` means one) so rate limits use the address
  the outermost one saw — never the client-supplied first entry.
- A session unused for `AZ_SESSION_IDLE_MINUTES` ends (default a day; 30 for
  stricter security requirements).
- Rate limits are counted per server process, so run a single process for
  now; limits are not yet shared between processes (backend-spec).

## 7. Social sign-in

Create an app in each provider's developer console, register the callback
`<AZ_BACKEND_PUBLIC_URL>/auth/oauth/<id>/callback`, and put its client id and
secret in `.env`. The site shows one "Continue with <label>" per configured
provider; labels come from your `.env`, never from az's code.

## 8. Before real users

Have the server reviewed by someone outside the project before real accounts
depend on it (backend-spec §11).

## 9. Maps in chat answers

A chat that shows `map` (chat-block-spec §21.4) draws its maps from tiles
**this server** serves under `/tiles/` — to the site's origins only, by HTTP
Range — so no third party learns where a visitor looks. Until an archive is
set, every map shows its list of places only (`az doctor` says so).

1. **Get a basemap archive.** The maps read one PMTiles v3 file in the schema
   of the `@protomaps/basemaps` styles (stack-evaluation §19). Download a
   planet build of that schema once, on a machine with the space for it.
2. **Cut the world to zoom 6** (about 46 MB) with the `pmtiles` command-line
   tool ([its documentation](https://docs.protomaps.com/pmtiles/cli)):

   ```sh
   pmtiles extract planet.pmtiles world.pmtiles --maxzoom=6
   ```

3. **Optionally, a regional extract** for detail where your visitors look —
   the maps then zoom as deep as it goes:

   ```sh
   pmtiles extract planet.pmtiles region.pmtiles --bbox=MIN_LON,MIN_LAT,MAX_LON,MAX_LAT
   ```

   (`--region=area.geojson` takes a polygon instead of a box.)
4. **Optionally, label fonts and icons**: a folder of glyph ranges
   (`<font name>/<start>-<end>.pbf`, the fonts the basemap styles name) and a
   folder of sprites (`light.json`, `light.png`, `dark.json`, `dark.png` and
   their `@2x` copies). Without them maps draw no place names or icons.
5. **Set them in `server/.env`**, paths from the server's folder:

   ```sh
   AZ_MAP_WORLD=./tiles/world.pmtiles
   AZ_MAP_REGION=./tiles/region.pmtiles
   AZ_MAP_GLYPHS=./tiles/glyphs
   AZ_MAP_SPRITES=./tiles/sprites
   AZ_MAP_ATTRIBUTION=<the attribution your tile data's licence requires>
   ```

   Data derived from the usual open source of world map data is under the
   ODbL, which requires its attribution under every map; the server will not
   start with an archive and no `AZ_MAP_ATTRIBUTION`. Each file is opened at
   start: a missing or foreign one stops the server, named by its key.
6. **Optionally, a geocoder** (`AZ_GEOCODER_URL`, https), so an answer may
   place an address: the server sends `GET <url>?q=<address>` and reads the
   first result's `lat` and `lon`; addresses are remembered a day and
   `AZ_GEOCODER_PER_ADDRESS` bounds the lookups one visitor causes.

Serve the site's built files with JavaScript's MIME type for `.mjs` as well
as `.js`: the map's worker is an `.mjs` module. A table a map reads stores
its coordinates as whole **millionths of a degree** in `number` fields
(`52520008` is 52.520008°): a `number` is whole (data-spec §3).

To read tiles from a host of your own choosing instead, build the site with
`AZ_PUBLIC_MAP_TILES_URL` set to that archive's URL: its origin enters the
map pages' `connect-src`, and `az doctor` names it — that host then sees
where every visitor's maps look.
