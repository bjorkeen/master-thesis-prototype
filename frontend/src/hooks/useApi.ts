/**
 * useApi.ts — Thin wrapper around axios for calling the gateway on :4000.
 *
 * Usage:
 *   const api = useApi();
 *   const state = await api.get<TwinState>('/api/twin/state');
 *   const result = await api.post<RoutingResponse>('/api/route', payload);
 *
 * All paths are relative to http://localhost:4000 — the gateway handles
 * routing to the correct Python service.
 */

import axios from 'axios';
import { useCallback } from 'react';

// The gateway base URL.  In a real deployment you'd use an env variable.
const BASE_URL = 'http://localhost:4000';

// Create a single axios instance shared across all calls.
const axiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 10_000,           // 10 seconds — prevents hanging requests
  headers: { 'Content-Type': 'application/json' },
});

// Optional: log every response error to the console so debugging is easier.
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('[api]', error.config?.url, error.response?.status, error.message);
    return Promise.reject(error);
  }
);

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------
export function useApi() {
  // GET request — returns the response data directly
  const get = useCallback(<T>(path: string, params?: Record<string, unknown>): Promise<T> => {
    return axiosInstance.get<T>(path, { params }).then((r) => r.data);
  }, []);

  // POST request — sends `body` as JSON, returns the response data
  const post = useCallback(<T>(path: string, body?: unknown): Promise<T> => {
    return axiosInstance.post<T>(path, body).then((r) => r.data);
  }, []);

  return { get, post };
}
