export interface Env {
  BUCKET: R2Bucket;
  META: KVNamespace;
  ASSETS: Fetcher;
  /** Cloudflare Access Application Audience (AUD). Comma-separated if multiple apps. */
  ACCESS_AUD?: string;
  /** e.g. https://your-team.cloudflareaccess.com */
  TEAM_DOMAIN?: string;
  /** Comma-separated emails allowed after Access JWT verify. Empty = any valid JWT. */
  UPLOAD_ALLOW_EMAILS?: string;
  /** Emergency upload gate password (API only; not shown in UI). */
  UPLOAD_GATE?: string;
  /** Set to "1" only for local wrangler dev. */
  DEV_OPEN_UPLOAD?: string;
  /** Google OAuth client (Drive + upload session). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Defaults to https://tools.yutok.dev/share/api/auth/google/callback */
  GOOGLE_REDIRECT_URI?: string;
  /** 32-byte key (base64 or hex) for encrypting Google refresh tokens in KV. */
  TOKEN_ENC_KEY?: string;
}
