# Booking.com adapter

The Booking.com channel adapter (`apps/api/src/modules/channel-manager/adapters/booking.adapter.ts`)
runs in one of two modes:

| Mode   | Trigger                              | Behaviour                                                                                                                                  |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `stub` | `BOOKING_ADAPTER_MODE` unset or any value other than `real` | Deterministic in-process responses (latency derived from a seeded PRNG). No network calls. Used for local dev and tests.                  |
| `real` | `BOOKING_ADAPTER_MODE=real`          | Hits Booking's Connectivity API: OAuth2 client-credentials token, then XML-over-HTTPS pushes / pulls. Requires valid `client_id` / `client_secret`. |

## Environment variables

| Variable                  | Required when     | Default                                  | Notes                                                                                       |
| ------------------------- | ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `BOOKING_ADAPTER_MODE`    | optional          | `stub`                                   | Set to `real` to enable network mode.                                                       |
| `BOOKING_API_BASE_URL`    | optional          | `https://supply-xml.booking.com`         | Override to point at Booking's sandbox / certification environment.                         |
| `BOOKING_OAUTH_URL`       | optional          | `https://oauth.booking.com/oauth2/token` | Override for sandbox OAuth endpoint.                                                        |
| `BOOKING_OAUTH_SCOPE`     | optional          | `supply-distribution-api`                | Default OAuth scope when the channel's `credentialsJson.scope` is unset.                    |

## Credentials

`Channel.credentialsJson` must contain at minimum:

```json
{
  "client_id":     "<from Booking partner portal>",
  "client_secret": "<from Booking partner portal>",
  "hotelId":       "12345678"
}
```

Optional fields: `scope` (override per channel).

`client_id` and `client_secret` are obtained from the Booking.com partner
portal during connectivity certification — they are NOT issued via the
public Booking for Business sign-up.

### Secret handling

`client_secret` is treated as a high-value secret and should rotate via the
platform's vault flow rather than through the Prisma field-encryption
extension (Sprint 32). The plain JSON column is acceptable for the canary
phase because (a) the database is access-controlled and (b) a follow-up
sprint moves the secret behind `Channel.credentialsSecretRef`. Do not check
real client secrets into source control or seed data.

## Rate limits

Booking enforces approximately **100 requests / minute / hotelId** across
all Distribution endpoints. The current adapter does not implement per-channel
queuing — production traffic should add a token bucket around
`pushXml`/`getXml` in `booking.adapter.ts` (look for the `TODO(rate-limit)`
markers). The aggregator already batches per sync job, which is enough for the
expected canary load but will not be enough for a hotel chain push.

## Sharp edges

- Reservations are parsed with a coarse regex, not a real XML parser. CDATA,
  namespaces, or nested tags with the same name will mis-extract; the fall-back
  path stashes the raw XML on `payloadJson.rawXml` so the aggregator can still
  dedupe by `externalReference`.
- OAuth tokens are cached in-memory per process. A redeploy or worker restart
  will invalidate the cache — that is fine (Booking permits parallel sessions)
  but adds latency to the first request after restart.
- Per-channel single-flight is not implemented; N parallel pushes that race a
  token expiry will each request a fresh token. Booking tolerates this but it
  is wasteful — a per-channel mutex is the right fix.
