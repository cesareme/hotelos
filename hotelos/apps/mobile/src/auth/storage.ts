/**
 * Sprint 37a — auth storage.
 *
 * Tries expo-secure-store first (preferred for JWTs), then
 * @react-native-async-storage/async-storage, then falls back to in-memory.
 * The mobile package.json does not list either today, so this resolves at
 * runtime via require() and silently degrades.
 */

type StorageBackend = {
  name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

function tryRequire<T>(id: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return null;
  }
}

function resolveBackend(): StorageBackend {
  const secure = tryRequire<{
    getItemAsync: (k: string) => Promise<string | null>;
    setItemAsync: (k: string, v: string) => Promise<void>;
    deleteItemAsync: (k: string) => Promise<void>;
  }>("expo-secure-store");
  if (secure) {
    return {
      name: "expo-secure-store",
      get: (k) => secure.getItemAsync(k),
      set: (k, v) => secure.setItemAsync(k, v),
      remove: (k) => secure.deleteItemAsync(k)
    };
  }

  const asyncStorageModule = tryRequire<{
    default: {
      getItem: (k: string) => Promise<string | null>;
      setItem: (k: string, v: string) => Promise<void>;
      removeItem: (k: string) => Promise<void>;
    };
  }>("@react-native-async-storage/async-storage");
  if (asyncStorageModule?.default) {
    const a = asyncStorageModule.default;
    return {
      name: "async-storage",
      get: (k) => a.getItem(k),
      set: (k, v) => a.setItem(k, v),
      remove: (k) => a.removeItem(k)
    };
  }

  const memory = new Map<string, string>();
  return {
    name: "memory",
    get: async (k) => memory.get(k) ?? null,
    set: async (k, v) => {
      memory.set(k, v);
    },
    remove: async (k) => {
      memory.delete(k);
    }
  };
}

const backend = resolveBackend();

const SESSION_KEY = "hotelos.staff.session.v1";

export type StoredSession = {
  accessToken: string;
  refreshToken?: string;
  user?: { id: string; name?: string; email: string; role?: string };
  property?: { id: string; name?: string };
};

export const authStorage = {
  backendName: backend.name,
  async load(): Promise<StoredSession | null> {
    const raw = await backend.get(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  },
  async save(session: StoredSession): Promise<void> {
    await backend.set(SESSION_KEY, JSON.stringify(session));
  },
  async clear(): Promise<void> {
    await backend.remove(SESSION_KEY);
  }
};
