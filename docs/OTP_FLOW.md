# OTP Flow

Two OTP purposes — **login** and **purchase** — all Redis-backed, 6-digit, 10-minute TTL.

## Limits

| | Value |
|---|---|
| Code length | 6 digits |
| Code TTL | 10 minutes |
| Verification token TTL | 15 minutes (purchase only) |
| Max attempts per code | 5 |
| Resend cooldown | 30 seconds |
| Storage | Redis (port 6380) |

Keys:

- `otp:login:{email}` — hash with `code`, `attempts`, `createdAt`.
- `otp:purchase:{email}` — same shape plus context (eventId, ticketTypeId, quantity) for the email template.
- `otp:resend:{purpose}:{email}` — cooldown flag, 30s TTL.
- `otp:token:purchase:{tokenId}` — opaque token returned after verify, 15-min TTL, one-shot.

## Login flow

```
client              backend                     redis      smtp
  │                    │                          │          │
  ├─POST /login────────▶│                          │          │
  │                    ├─set otp:login─────────▶ │          │
  │                    ├─sendOtpEmail────────────────────▶ │
  │◀─{ otpRequired }───┤                          │          │
  │                    │                          │          │
  ├─POST /login-verify-otp─▶                     │          │
  │                    ├─validate + delete──────▶│          │
  │◀─{ token }─────────┤                          │          │
```

Short-circuits that return `{ token }` on the first `/login`:

- `organizer.otpLoginDisabled === true` (user-opted out via `POST /api/auth/otp-login-pref`).
- Ghost-wallet accounts (`/^0x[0-9a-f]+@wallet\.gembaticket\.com$/i`) — no real inbox, so no OTP.
- SIWE sign-ins entirely bypass `/login`.

## Purchase flow (guest only)

```
client                backend                      redis      smtp
  │                      │                          │          │
  ├─/purchase-otp/send──▶│                          │          │
  │                      ├─set otp:purchase──────▶ │          │
  │                      ├─sendOtpEmail(ctx)──────────────▶ │
  │◀──ok────────────────┤                          │          │
  │                      │                          │          │
  ├─/purchase-otp/verify▶│                          │          │
  │                      ├─validate + delete─────▶ │          │
  │                      ├─set otp:token─────────▶ │          │
  │◀─{ token }──────────┤                          │          │
  │                      │                          │          │
  ├─POST /tickets/buy { …, otpToken }─▶             │          │
  │                      ├─validate + delete otp:token───▶│   │
  │                      ├─create ghost wallet if missing │   │
  │                      ├─GembaPay createPayment──────────▶│  │
  │◀─{ paymentUrl, ticketId }                      │          │
```

Logged-in requests (JWT, real or ghost) skip the `otpToken` requirement.

## Email template (purchase)

The purchase OTP email includes:

- Event name
- Venue
- Event date/time (localised via `toLocaleString("en-GB")`)
- Ticket type
- Quantity (`× N` if > 1)

so the recipient can confirm they are paying for the right thing before typing the code.

## Error surface (user-visible)

| Backend message | UI treatment |
|---|---|
| `Invalid code` | "Incorrect code (N attempts left)" |
| `Code expired` | "Code expired — request a new one" |
| `Too many attempts` | "Too many attempts — request a new code" |
| `Please wait before requesting a new code` | Disable resend button with countdown |

## Testing (dev only)

```bash
# Trigger a login OTP
curl -X POST http://localhost:3080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"..."}'
# → { "otpRequired": true }

# Inspect in Redis
redis-cli -p 6380 HGETALL otp:login:test@example.com
```
