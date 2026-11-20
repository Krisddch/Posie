# Turning on sync (email link, and later Sign in with Apple)

Posie works fully without an account. To sync between devices you need a free **Supabase** project.
Signing in by **email link** is free and works as soon as Supabase is set up.
**Sign in with Apple** is optional and needs the paid Apple Developer Program ($99/year); set
`appleSignIn: true` in `config.js` once it's configured.

## 1. Supabase (≈5 min)

1. Create a project at https://supabase.com (free tier is fine).
2. **SQL Editor** → paste [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Project Settings → API Keys**: copy the **anon / publishable** key into [`config.js`](config.js) (the URL is already there).
4. **Authentication → URL Configuration** (important, otherwise sign-in links go to `localhost:3000`):
   - Site URL: `https://krisddch.github.io/Posie/`
   - Redirect URLs: add `https://krisddch.github.io/Posie/**` and `http://localhost:5173/**`
5. Optional, recommended: **Authentication → Emails → Magic Link**, add this line to the email body so you can also type a code
   (handy when the email arrives on another device): `<p>Or type this code in Posie: <b>{{ .Token }}</b></p>`

Email sign-in now works (Supabase sends the emails; the free plan allows a few per hour, plenty for personal use).
For one-tap sharing from Pinterest, also deploy the link-preview function: see [SHARE.md](SHARE.md).

## 2. Apple (optional: Sign in with Apple, paid program only)

Go straight to https://developer.apple.com/account/resources/identifiers/list (or: developer.apple.com → person icon top-right → **Account** → **Certificates, Identifiers & Profiles**). If you only see "Join the Apple Developer Program", your membership is still being processed (it can take up to 48 hours).
Do Supabase step 1 first: you need your project address (`arnpmovrwyceifulfmzd.supabase.co`) below.

**a) App ID** (the "app" that owns Sign in with Apple)
1. **Identifiers** → **+** → **App IDs** → Continue → type **App** → Continue.
2. Description: `Posie`. Bundle ID: **Explicit**, e.g. `com.krisddch.posie`.
3. Scroll the Capabilities list, tick **Sign in with Apple** → Continue → **Register**.

**b) Services ID** (what the website uses; this is your *Client ID*)
1. **Identifiers** → **+** → **Services IDs** → Continue.
2. Description: `Posie Web`. Identifier: `com.krisddch.posie.web` → Continue → **Register**.
3. Open the new Services ID → tick **Sign in with Apple** → **Configure**:
   - Primary App ID: `com.krisddch.posie`
   - Domains and Subdomains: `arnpmovrwyceifulfmzd.supabase.co`
   - Return URLs: `https://arnpmovrwyceifulfmzd.supabase.co/auth/v1/callback`
   → **Next** → **Done** → **Continue** → **Save**.

**c) Key** (lets Supabase prove it's you)
1. **Keys** → **+** → name `Posie Sign in with Apple` → tick **Sign in with Apple** → **Configure** →
   choose `com.krisddch.posie` → **Save** → Continue → **Register**.
2. **Download** the `.p8` file. Apple only lets you download it once, so keep it somewhere safe and never commit it.
3. Note the **Key ID** (shown on the key page) and your **Team ID** (top-right under your name, or in **Membership details**).

## 3. Connect them

Supabase → **Authentication → Sign In / Providers → Apple** → enable:
- **Client IDs**: `com.krisddch.posie.web` (the Services ID)
- **Secret Key (for OAuth)**: a signed token made from your `.p8` key, Key ID, Team ID and Services ID.
  Supabase's Apple guide links to a small generator for this. Apple makes this secret expire after
  at most 6 months, so set a reminder to regenerate it.

Commit `config.js`, and the "Sign in with Apple" button (tap **posie** in the top-left corner) goes live.

## How sync behaves

- Your board is always saved on the device first, so it's fast and works offline.
- After signing in, everything is merged (newest edit wins per pin), and each change is uploaded a second later.
- Coming back to the tab pulls changes from your other devices.
- Signing out keeps the board on that device; it just stops syncing.
