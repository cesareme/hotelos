export type ApiClientConfig = {
  baseUrl: string;
};

export function createApiClient(config: ApiClientConfig) {
  return {
    async get<TResponse>(path: string): Promise<TResponse> {
      const response = await fetch(`${config.baseUrl}${path}`);

      if (!response.ok) {
        throw new Error(`API call failed: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as TResponse;
    },

    async post<TResponse>(path: string, body: unknown): Promise<TResponse> {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as TResponse;
    }
  };
}
