/**
 * Default handler for the OAuth provider: drives the *upstream* Google consent
 * flow. workers-oauth-provider owns the Claude <-> Worker side (issuing tokens
 * to the MCP client); this handler bridges to Google so the user authorizes via
 * the real Google account-chooser — i.e. "grant the app access" as intended.
 *
 * Flow:
 *   GET /authorize  -> stash Claude's AuthRequest in `state`, redirect to Google
 *   GET /callback   -> exchange code at Google, read email, completeAuthorization
 *
 * Single-user note: we encode Claude's AuthRequest into the OAuth `state` param
 * rather than persisting it server-side, and rely on Google's own consent screen
 * as the approval gate (no separate local approval dialog).
 */
import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./types";
import { ICON_PNG_BASE64 } from "./icon";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

// Baseline security headers on every response from this handler (consent,
// callback, icon). Helps satisfy the ASVS checks a CASA assessment runs.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
});

function encodeState(req: AuthRequest): string {
  return btoa(JSON.stringify(req)).replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeState(state: string): AuthRequest {
  const json = atob(state.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as AuthRequest;
}

// --- Hardening: owner allowlist, redirect allowlist, browser-bound state ---

const STATE_COOKIE = "__Host-gh_oauth_state";

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

function randomNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function redirectAllowed(env: Env, redirectUri: string): boolean {
  // Exact match only — no prefix games.
  return csv(env.ALLOWED_REDIRECT_URIS).includes(redirectUri);
}

function callbackUrl(reqUrl: string): string {
  return new URL("/callback", reqUrl).toString();
}

// Connector icon (the Google Health heart). Referenced from the MCP serverInfo
// `icons` so clients that render server branding (e.g. Claude's connector list)
// can show a logo. Decoded once from the base64-embedded PNG.
const ICON_PNG_BYTES = Uint8Array.from(atob(ICON_PNG_BASE64), (c) => c.charCodeAt(0));

app.get("/icon.png", (c) =>
  c.body(ICON_PNG_BYTES, 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  }),
);

// Minimal homepage + privacy policy, required by Google to publish the
// OAuth consent screen to Production.
const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
  `<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">` +
  `<h1>${title}</h1>${body}</body></html>`;

app.get("/", (c) =>
  c.html(
    PAGE(
      "Personal Google Health MCP",
      "<p>A private, single-user server that lets the owner's Claude connectors read the owner's own Google Health data, read-only. It is not offered to the public.</p>" +
        '<p><a href="/privacy">Privacy policy</a></p>',
    ),
  ),
);

app.get("/privacy", (c) =>
  c.html(
    PAGE(
      "Privacy policy",
      "<p>This server is for personal use by its owner only; other accounts are refused.</p>" +
        "<ul><li>It requests read-only access to Google Health data and the account email.</li>" +
        "<li>Data is fetched on request and passed only to the owner's MCP client (Claude). It is not sold, shared, or used for advertising.</li>" +
        "<li>OAuth tokens and a short-lived cache of past-day responses are stored encrypted in the owner's Cloudflare account.</li>" +
        "<li>Access can be revoked at any time at myaccount.google.com/permissions.</li></ul>" +
        "<p>Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>",
    ),
  ),
);

// Step 1: Claude hits /authorize. Parse its request, bounce to Google.
app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

  // Only issue codes to known MCP clients (e.g. Claude), never an arbitrary
  // dynamically-registered client's redirect URI.
  if (!redirectAllowed(c.env, oauthReq.redirectUri)) {
    return c.text("Redirect URI not allowed", 403);
  }

  // Bind this flow to the browser that started it.
  const nonce = randomNonce();
  c.header(
    "Set-Cookie",
    `${STATE_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  );

  const scopes = `openid email ${c.env.GOOGLE_OAUTH_SCOPES}`.trim();
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: "code",
    scope: scopes,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh-token issuance on re-auth
    state: `${nonce}.${encodeState(oauthReq)}`,
  });
  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

// Step 2: Google redirects back with ?code & ?state.
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.text("Missing code or state from Google", 400);
  }

  // Verify the state was issued to *this* browser at /authorize.
  const dot = state.indexOf(".");
  const stateNonce = dot > 0 ? state.slice(0, dot) : "";
  const cookieNonce = readCookie(c.req.header("Cookie"), STATE_COOKIE);
  c.header("Set-Cookie", `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  if (!stateNonce || !cookieNonce || !timingSafeEqual(stateNonce, cookieNonce)) {
    return c.text("Invalid or expired OAuth state. Start the connection again from Claude.", 400);
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = decodeState(state.slice(dot + 1));
  } catch {
    return c.text("Malformed OAuth state", 400);
  }
  if (!redirectAllowed(c.env, oauthReq.redirectUri)) {
    return c.text("Redirect URI not allowed", 403);
  }

  // Exchange the authorization code for tokens.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.req.url),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return c.text(`Google token exchange failed: ${await tokenRes.text()}`, 502);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  // Identify the user (for the grant's userId) via the email scope.
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = (await userRes.json()) as {
    email?: string;
    email_verified?: boolean;
    sub?: string;
  };

  // Owner allowlist: only the configured Google account(s) may connect.
  const allowed = csv(c.env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
  const email = (userInfo.email ?? "").toLowerCase();
  if (!userRes.ok || !email || userInfo.email_verified !== true || !allowed.includes(email)) {
    // Best effort: revoke the token we just obtained so it isn't left live.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.access_token)}`, {
      method: "POST",
    }).catch(() => {});
    return c.text("This Google account is not authorized for this server.", 403);
  }

  const props: Props = {
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: email,
    scope: oauthReq.scope,
    metadata: { label: email },
    props,
  });

  return c.redirect(redirectTo);
});

export { app as GoogleHandler };
