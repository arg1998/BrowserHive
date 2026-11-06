/** @module sw/scope — the part of `ServiceWorkerGlobalScope` the workers use (a fake one in tests) and `retire()`, shared by the offline worker (`sw.ts`) and the kill switch (04 §18.5). */
import { isOwnCache } from './sw-core.ts';

/** An event whose lifetime the worker can extend. */
export interface WorkerExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/** A `fetch` event. */
export interface WorkerFetchEvent extends WorkerExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

/** The part of `CacheStorage` the workers use. */
export interface WorkerCacheStorage {
  open(name: string): Promise<Pick<Cache, 'put'>>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
  match(
    request: Request | string,
    options: { readonly cacheName: string; readonly ignoreVary: boolean },
  ): Promise<Response | undefined>;
}

/** The part of `ServiceWorkerGlobalScope` the workers use. */
export interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: WorkerCacheStorage;
  readonly registration: { unregister(): Promise<boolean> };
  readonly clients: { claim(): Promise<void> };
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(id: number): void;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: WorkerExtendableEvent) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: WorkerFetchEvent) => void): void;
}

/** Deletes every cache whose name `drop` accepts. */
export async function deleteCaches(
  scope: Pick<WorkerScope, 'caches'>,
  drop: (name: string) => boolean,
): Promise<void> {
  const names = await scope.caches.keys();
  await Promise.all(names.filter(drop).map((name) => scope.caches.delete(name)));
}

/**
 * Removes the worker from this address: deletes every `bh-offline-*` cache, then unregisters
 * (04 §18.5.4, §18.5.7).
 */
export async function retire(scope: Pick<WorkerScope, 'caches' | 'registration'>): Promise<void> {
  await deleteCaches(scope, isOwnCache);
  await scope.registration.unregister();
}
