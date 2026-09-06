export interface Env {
  BUCKET: R2Bucket;
  META: KVNamespace;
  ASSETS: Fetcher;
  ACCESS_AUD?: string;
  DEV_OPEN_UPLOAD?: string;
}
