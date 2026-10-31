// Which deployments are previews Intenzo may use (§17.1, §29). Production is recognized by its
// environment's name, because Vercel sends production_environment: false even on Production
// (T0.4). A production deployment is never used, on either side, whatever .intenzo.yml says.
import type { IntenzoConfig } from "@intenzo/core";

/** The deployment states Intenzo stores. Vercel posts only the final one (T0.4). */
export const FINAL_STATES: ReadonlySet<string> = new Set(["success", "failure", "error"]);

/**
 * Vercel's `Production`, and any name that starts with "prod" or says "production". The rule errs
 * toward production: a name it catches by mistake ("product-preview") is only never used.
 */
export function isProductionEnvironment(environment: string): boolean {
  return /^\s*prod|production/i.test(environment);
}

/**
 * §17.1: the environment starts with preview.environment_prefix and, when preview.project is set,
 * contains it, both in any case. A production environment never matches, whatever the prefix.
 */
export function isPreviewEnvironment(
  environment: string,
  preview: IntenzoConfig["preview"],
): boolean {
  const name = environment.toLowerCase();
  return (
    !isProductionEnvironment(environment) &&
    name.startsWith(preview.environment_prefix.toLowerCase()) &&
    (preview.project === undefined || name.includes(preview.project.toLowerCase()))
  );
}

/** §17.1: a deployment status's environment_url, else its target_url. Only https URLs count. */
export function deploymentUrl(status: {
  environment_url?: string | null;
  target_url?: string | null;
}): string | null {
  for (const candidate of [status.environment_url, status.target_url]) {
    if (candidate && URL.parse(candidate)?.protocol === "https:") return candidate;
  }
  return null;
}

/** §17.3, §29: the URL is on one of the repo's production domains, or a subdomain of one. */
export function onProductionDomain(url: string, prodDomains: readonly string[]): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return prodDomains.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\.+|\.+$/g, "");
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
}

export interface PreviewRules {
  preview: IntenzoConfig["preview"];
  /** repos.prod_domains: a second line of defence behind the environment name (§29). */
  prodDomains: readonly string[];
}

/** A stored deployment's URL when Intenzo may use it as a preview, else null. */
export function previewUrl(
  deployment: { environment: string; state: string; url: string | null },
  rules: PreviewRules,
): string | null {
  const { environment, state, url } = deployment;
  if (state !== "success" || url === null) return null;
  if (!isPreviewEnvironment(environment, rules.preview)) return null;
  return onProductionDomain(url, rules.prodDomains) ? null : url;
}
