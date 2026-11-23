/** Only bucket-relative, caller-owned keys may reach privileged Storage.delete. */
export function userShipPhotoObjectKey(imageUrl: string, userId: string): string | null {
  try {
    const path = new URL(imageUrl, 'https://storage.invalid').pathname;
    const marker = '/storage/v1/object/public/ship-images/';
    const at = path.indexOf(marker);
    if (at < 0) return null;
    const key = decodeURIComponent(path.slice(at + marker.length));
    const prefix = `user-photos/${userId}/`;
    if (!key.startsWith(prefix)) return null;
    const parts = key.slice(prefix.length).split('/');
    if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,159}$/.test(part))) return null;
    return key;
  } catch {
    return null;
  }
}
