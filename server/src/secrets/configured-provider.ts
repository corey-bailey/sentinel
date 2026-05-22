import { SECRET_PROVIDERS, type SecretProvider } from "@sentinel/shared";

export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.SENTINEL_SECRETS_PROVIDER;
  return configuredProvider && SECRET_PROVIDERS.includes(configuredProvider as SecretProvider)
    ? configuredProvider as SecretProvider
    : "local_encrypted";
}
