/** Service options from environment variables. A variable left blank, as an
 * env file often does, counts as unset rather than as an empty value. */
export function serviceOptions(env: NodeJS.ProcessEnv) {
  const text = (value: string | undefined) => value?.trim() || undefined;
  const list = (value: string | undefined) => {
    const items = text(value)
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return items?.length ? items : undefined;
  };
  return {
    host: text(env.DURABLE_FACTORY_HOST),
    allowedHosts: list(env.DURABLE_FACTORY_ALLOWED_HOSTS),
    allowedOrigins: list(env.DURABLE_FACTORY_ALLOWED_ORIGINS),
    authToken: text(env.DURABLE_FACTORY_API_TOKEN),
  };
}
