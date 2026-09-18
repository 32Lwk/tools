/**
 * Google Drive resumable upload (browser → Drive, Worker only mints tokens/meta).
 */

const CHUNK = 8 * 1024 * 1024; // 8 MiB

/**
 * @param {{
 *   accessToken: string,
 *   resumableCreate: string,
 *   metadata: { name: string, mimeType: string, parents: string[] },
 *   file: File,
 *   onProgress?: (pct: number, loaded: number, total: number) => void,
 * }} opts
 * @returns {Promise<{ id: string, name?: string, size?: string, mimeType?: string }>}
 */
export async function uploadToDriveResumable(opts) {
  const { accessToken, resumableCreate, metadata, file, onProgress } = opts;

  const startRes = await fetch(resumableCreate, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": metadata.mimeType || file.type || "application/octet-stream",
      "x-upload-content-length": String(file.size),
    },
    body: JSON.stringify(metadata),
  });
  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Drive session 開始に失敗: ${startRes.status} ${errText.slice(0, 200)}`);
  }
  const uploadUrl = startRes.headers.get("location");
  if (!uploadUrl) throw new Error("Drive resumable URL がありません");

  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const chunk = file.slice(offset, end);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-length": String(chunk.size),
        "content-range": `bytes ${offset}-${end - 1}/${file.size}`,
        "content-type": metadata.mimeType || file.type || "application/octet-stream",
      },
      body: chunk,
    });

    if (res.status === 200 || res.status === 201) {
      onProgress?.(100, file.size, file.size);
      return (await res.json());
    }
    if (res.status === 308) {
      offset = end;
      onProgress?.(Math.round((offset / file.size) * 100), offset, file.size);
      continue;
    }
    const errText = await res.text();
    throw new Error(`Drive アップロード失敗: ${res.status} ${errText.slice(0, 200)}`);
  }
  throw new Error("Drive アップロードが完了しませんでした");
}
