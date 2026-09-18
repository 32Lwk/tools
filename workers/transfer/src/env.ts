export interface Env {
  BUCKET: R2Bucket;
  META: KVNamespace;
  ASSETS: Fetcher;
  /** Cloudflare Access Application Audience (AUD). Optional if UPLOAD_GATE is set. */
  ACCESS_AUD?: string;
  /** e.g. https://your-team.cloudflareaccess.com */
  TEAM_DOMAIN?: string;
  /** Comma-separated emails allowed after Access JWT verify. Empty = any valid JWT. */
  UPLOAD_ALLOW_EMAILS?: string;
  /** Shared upload gate password (Owner only). Preferred when Access AUD is not configured. */
  UPLOAD_GATE?: string;
  /** Set to "1" only for local wrangler dev. */
  DEV_OPEN_UPLOAD?: string;
}
