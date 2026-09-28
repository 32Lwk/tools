export interface Env {
  BUCKET: R2Bucket;
  META: KVNamespace;
  ASSETS: Fetcher;
  /** Cloudflare Email Sending binding (optional until onboarded). */
  EMAIL?: SendEmail;
  /** Cloudflare Access Application Audience (AUD). Comma-separated if multiple apps. */
  ACCESS_AUD?: string;
  /** e.g. https://your-team.cloudflareaccess.com */
  TEAM_DOMAIN?: string;
  /** Comma-separated emails allowed after Access JWT verify. Empty = any valid JWT. */
  UPLOAD_ALLOW_EMAILS?: string;
  /** Shared upload gate password (primary auth for external uploaders). */
  UPLOAD_GATE?: string;
  /** Set to "1" only for local wrangler dev. */
  DEV_OPEN_UPLOAD?: string;
  /** Google OAuth client (Drive + upload session). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Defaults to https://tools.yutok.dev/share/api/auth/google/callback */
  GOOGLE_REDIRECT_URI?: string;
  /** 32-byte key (base64 or hex) for encrypting Google refresh tokens in KV and picture-challenge tokens. */
  TOKEN_ENC_KEY?: string;
  /** Override notify recipient (default: yuto.k051028@gmail.com). */
  NOTIFY_TO?: string;
  /** Gmail account that sends notify mail (default: NOTIFY_TO). */
  NOTIFY_GMAIL?: string;
  /** Refresh token for notify (kakeibo / gmail-mcp). Prefer this so gate uploads need no Google login. */
  NOTIFY_GMAIL_REFRESH_TOKEN?: string;
  /** Optional Cloudflare EMAIL From (only if using CF Email to verified dest). */
  NOTIFY_FROM?: string;
}
