import { jwtDecode } from "jwt-decode";

function jwtExpired(token?: string): boolean {
  if (!token) return true;
  // Positron: a personal access token is not a JWT and has no expiry here
  if (!decodeJWT(token)) return false;
  const decoded = jwtDecode(token);
  return expired(decoded.exp);
}

function expired(timestamp?: number): boolean {
  if (!timestamp) return true;
  const currentTime = Date.now() / 1000;
  return timestamp < currentTime;
}

function decodeJWT(token?: string): any {
  if (!token) return null;
  // Positron: tolerate personal access tokens, which are not JWTs
  try {
    return jwtDecode(token);
  } catch {
    return null;
  }
}

export { jwtExpired, decodeJWT, expired };
