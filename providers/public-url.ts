import { isIP } from "node:net";
import { ProviderError } from "./pricing.js";
/** Public web evidence only; never forward local endpoints or credential URLs. */
export function publicUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new ProviderError(
      "INVALID_INPUT",
      "A complete public HTTPS URL is required.",
    );
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    input.length > 4000 ||
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host) ||
    [...u.searchParams.keys()].some((k) =>
      /(?:token|password|secret|session|api.?key|auth|signature)/i.test(k),
    )
  )
    throw new ProviderError(
      "INVALID_INPUT",
      "Use a public HTTPS page without credentials, local addresses or secret query parameters.",
    );
  u.hash = "";
  return u.href;
}
