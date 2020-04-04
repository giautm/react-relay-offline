/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow strict-local
 */

'use strict';

/* global jest */

import areEqual from 'fbjs/lib/areEqual';
import invariant from 'fbjs/lib/invariant';

const {
  QueryResponseCache,
  Observable,
  Network,
} = require('relay-runtime');

import { Store, RecordSource, Environment } from "../src";
import { createPersistedStorage } from './Utils';

type PendingRequest = {
  request: any,
  variables: any,
  cacheConfig: any,
  sink: any,
};

const MAX_SIZE = 10;
const MAX_TTL = 5 * 60 * 1000; // 5 min

function mockInstanceMethod(object: any, key: string) {
  object[key] = jest.fn(object[key].bind(object));
}

function mockDisposableMethod(object: any, key: string) {
  const fn = object[key].bind(object);
  object[key] = jest.fn((...args) => {
    const disposable = fn(...args);
    const dispose = jest.fn(() => disposable.dispose());
    object[key].mock.dispose = dispose;
    return {dispose};
  });
  const mockClear = object[key].mockClear.bind(object[key]);
  object[key].mockClear = () => {
    mockClear();
    object[key].mock.dispose = null;
  };
}

function mockObservableMethod(object: any, key: string) {
  const fn = object[key].bind(object);
  object[key] = jest.fn((...args) =>
    fn(...args).do({
      start: subscription => {
        object[key].mock.subscriptions.push(subscription);
      },
    }),
  );
  object[key].mock.subscriptions = [];
  const mockClear = object[key].mockClear.bind(object[key]);
  object[key].mockClear = () => {
    mockClear();
    object[key].mock.subscriptions = [];
  };
}

type OperationMockResolver = (
  operation: any,
) => any | Error;

type MockFunctions = {
  clearCache: () => void,
  cachePayload: (
    request: any | any,
    variables: any,
    payload: any,
  ) => void,
  isLoading: (
    request: any | any,
    variables: any,
    cacheConfig?: any,
  ) => boolean,
  reject: (
    request: any | any,
    error: Error | string,
  ) => void,
  nextValue: (
    request: any | any,
    payload: any,
  ) => void,
  complete: (request: any | any) => void,
  resolve: (
    request: any | any,
    payload: any,
  ) => void,
  getAllOperations: () => ReadonlyArray<any>,
  findOperation: (
    findFn: (operation: any) => boolean,
  ) => any,
  getMostRecentOperation: () => any,
  resolveMostRecentOperation: (
    payload:
      | any
      | ((operation: any) => any),
  ) => void,
  rejectMostRecentOperation: (
    error: Error | ((operation: any) => Error),
  ) => void,
  queueOperationResolver: (resolver: OperationMockResolver) => void,
};

interface MockEnvironment {
  mock: MockFunctions;
  mockClear: () => void;
}

export interface RelayMockEnvironment extends MockEnvironment {}

/**
 * Creates an instance of the `Environment` interface defined in
 * RelayStoreTypes with a mocked network layer.
 *
 * Usage:
 *
 * ```
 * const environment = RelayModernMockEnvironment.createMockEnvironment();
 * ```
 *
 * Mock API:
 *
 * Helpers are available as `environment.mock.<helper>`:
 *
 * - `isLoading(query, variables): boolean`: Determine whether the given query
 *   is currently being loaded (not yet rejected/resolved).
 * - `reject(query, error: Error): void`: Reject a query that has been fetched
 *   by the environment.
 * - `resolve(query, payload: PayloadData): void`: Resolve a query that has been
 *   fetched by the environment.
 * - `nextValue(...) - will add payload to the processing, but won't complete
 *   the request ()
 * - getAllOperations() - every time there is an operation created by
 *   the Relay Component (query, mutation, subscription) this operation will be
 *   added to the internal list on the Mock Environment. This method will return
 *   an array of all pending operations in the order they occurred.
 * - findOperation(findFn) - should find operation if findFn(...) return `true`
 *   for it. Otherwise, it will throw.
 * - getMostRecentOperation(...) - should return the most recent operation
 *   generated by Relay Component.
 * - resolveMostRecentOperation(...) - is accepting `any` or a
 *   callback function that will receive `operation` and should return
 *  `any`
 * - rejectMostRecentOperation(...) - should reject the most recent operation
 *   with a specific error
 */
export function createMockEnvironment(config?: {
  handlerProvider?: any,
  missingFieldHandlers?: ReadonlyArray<any>,
  operationTracker?: any,
  operationLoader?: any,
  store?: any,
}): RelayMockEnvironment {
  const store = config?.store ?? new Store(new RecordSource({ storage: createPersistedStorage()}), {storage: createPersistedStorage(), defaultTTL: -1});
  const cache = new QueryResponseCache({
    size: MAX_SIZE,
    ttl: MAX_TTL,
  });

  let pendingRequests: ReadonlyArray<PendingRequest> = [];
  let pendingOperations: ReadonlyArray<any> = [];
  let resolversQueue: ReadonlyArray<OperationMockResolver> = [];

  const queueOperationResolver = (resolver: OperationMockResolver): void => {
    resolversQueue = resolversQueue.concat([resolver]);
  };

  // Mock the network layer
  const execute = (
    request: any,
    variables: any,
    cacheConfig: any,
  ) => {
    const {id, text} = request;
    const cacheID = id ?? text;

    let cachedPayload = null;
    if (
      (cacheConfig?.force == null || cacheConfig?.force === false) &&
      cacheID != null
    ) {
      cachedPayload = cache.get(cacheID, variables);
    }
    if (cachedPayload !== null) {
      return Observable.from(cachedPayload);
    }

    const currentOperation = pendingOperations.find(
      op =>
        op.request.node.params === request &&
        op.request.variables === variables,
    );

    // Handle network responses added by
    if (currentOperation != null && resolversQueue.length > 0) {
      const currentResolver = resolversQueue[0];
      const result = currentResolver(currentOperation);
      if (result != null) {
        resolversQueue = resolversQueue.filter(res => res !== currentResolver);
        pendingOperations = pendingOperations.filter(
          op => op !== currentOperation,
        );
        if (result instanceof Error) {
          return Observable.create(sink => {
            sink.error(result);
          });
        } else {
          return Observable.from(result);
        }
      }
    }

    return Observable.create(sink => {
      const nextRequest = {request, variables, cacheConfig, sink};
      pendingRequests = pendingRequests.concat([nextRequest]);

      return () => {
        pendingRequests = pendingRequests.filter(
          pending => !areEqual(pending, nextRequest),
        );
        pendingOperations = pendingOperations.filter(
          op => op !== currentOperation,
        );
      };
    });
  };

  function getConcreteRequest(
    input: any | any,
  ): any {
    if (input.kind === 'Request') {
      const request: any = (input as any);
      return request;
    } else {
      const operationDescriptor: any = (input as any);
      invariant(
        pendingOperations.includes(operationDescriptor),
        'RelayModernMockEnvironment: Operation "%s" was not found in the list of pending operations',
        operationDescriptor.request.node.operation.name,
      );
      return operationDescriptor.request.node;
    }
  }

  // The same request may be made by multiple query renderers
  function getRequests(
    input: any | any,
  ): ReadonlyArray<PendingRequest> {
    let concreteRequest: any;
    let operationDescriptor: any;
    if (input.kind === 'Request') {
      concreteRequest = (input as any);
    } else {
      operationDescriptor = (input as any);
      concreteRequest = operationDescriptor.request.node;
    }
    const foundRequests = pendingRequests.filter(pending => {
      if (!areEqual(pending.request, concreteRequest.params)) {
        return false;
      }
      if (operationDescriptor) {
        // If we handling `any` we also need to check variables
        // and return only pending request with equal variables
        return areEqual(
          operationDescriptor.request.variables,
          pending.variables,
        );
      } else {
        // In the case we received `any` as input we will return
        // all pending request, even if they have different variables
        return true;
      }
    });
    invariant(
      foundRequests.length,
      'MockEnvironment: Cannot respond to request, it has not been requested yet.',
    );
    foundRequests.forEach(foundRequest => {
      invariant(
        foundRequest.sink,
        'MockEnvironment: Cannot respond to `%s`, it has not been requested yet.',
        concreteRequest.params.name,
      );
    });
    return foundRequests;
  }

  function ensureValidPayload(payload: any) {
    invariant(
      typeof payload === 'object' &&
        payload !== null &&
        payload.hasOwnProperty('data'),
      'MockEnvironment(): Expected payload to be an object with a `data` key.',
    );
    return payload;
  }

  const cachePayload = (
    request: any | any,
    variables: any,
    payload: any,
  ): void => {
    const {id, text} = getConcreteRequest(request).params;
    const cacheID = id ?? text;
    invariant(cacheID != null, 'CacheID should not be null');
    cache.set(cacheID, variables, payload);
  };

  const clearCache = (): void => {
    cache.clear();
  };

  // Helper to determine if a given query/variables pair is pending
  const isLoading = (
    request: any | any,
    variables: any,
    cacheConfig?: any,
  ): boolean => {
    return pendingRequests.some(
      pending =>
        areEqual(pending.request, getConcreteRequest(request).params) &&
        areEqual(pending.variables, variables) &&
        areEqual(pending.cacheConfig, cacheConfig ?? {}),
    );
  };

  // Helpers to reject or resolve the payload for an individual request.
  const reject = (
    request: any | any,
    error: Error | string,
  ): void => {
    const rejectError = typeof error === 'string' ? new Error(error) : error;
    getRequests(request).forEach(foundRequest => {
      const {sink} = foundRequest;
      invariant(sink !== null, 'Sink should be defined.');
      sink.error(rejectError);
    });
  };

  const nextValue = (
    request: any | any,
    payload: any,
  ): void => {
    getRequests(request).forEach(foundRequest => {
      const {sink} = foundRequest;
      invariant(sink !== null, 'Sink should be defined.');
      sink.next(ensureValidPayload(payload));
    });
  };

  const complete = (request: any | any): void => {
    getRequests(request).forEach(foundRequest => {
      const {sink} = foundRequest;
      invariant(sink !== null, 'Sink should be defined.');
      sink.complete();
    });
  };

  const resolve = (
    request: any | any,
    payload: any,
  ): void => {
    getRequests(request).forEach(foundRequest => {
      const {sink} = foundRequest;
      invariant(sink !== null, 'Sink should be defined.');
      sink.next(ensureValidPayload(payload));
      sink.complete();
    });
  };

  const getMostRecentOperation = (): any => {
    const mostRecentOperation = pendingOperations[pendingOperations.length - 1];
    invariant(
      mostRecentOperation != null,
      'RelayModernMockEnvironment: There are no pending operations in the list',
    );
    return mostRecentOperation;
  };

  const findOperation = (
    findFn: (operation: any) => boolean,
  ): any => {
    const pendingOperation = pendingOperations.find(findFn);
    invariant(
      pendingOperation != null,
      'RelayModernMockEnvironment: Operation was not found in the list of pending operations',
    );
    return pendingOperation;
  };

  // @ts-ignore
  const environment: RelayMockEnvironment = new Environment({
    configName: 'RelayModernMockEnvironment',
    loggerProvider: {
      getLogger() {
        return null;
      },
    },
    network: Network.create(execute, execute),
    store,
    ...config,
  });

  const createExecuteProxy = (
    env: any,
    fn: any,
  ) => {
    return (...argumentsList) => {
      const [{operation}] = argumentsList;
      pendingOperations = pendingOperations.concat([operation]);
      return fn.apply(env, argumentsList);
    };
  };

  // @ts-ignore
  environment.execute = createExecuteProxy(environment, environment.execute);
  // @ts-ignore
  environment.executeMutation = createExecuteProxy(
    environment,
    // @ts-ignore
    environment.executeMutation,
  );

  if (global?.process?.env?.NODE_ENV === 'test') {
    // Mock all the functions with their original behavior
    mockDisposableMethod(environment, 'applyUpdate');
    mockInstanceMethod(environment, 'commitPayload');
    mockInstanceMethod(environment, 'getStore');
    mockInstanceMethod(environment, 'lookup');
    mockInstanceMethod(environment, 'check');
    mockDisposableMethod(environment, 'subscribe');
    mockDisposableMethod(environment, 'retain');
    // @ts-ignore
    mockObservableMethod(environment, 'execute');
    // @ts-ignore
    mockObservableMethod(environment, 'executeMutation');

    mockInstanceMethod(store, 'getSource');
    mockInstanceMethod(store, 'lookup');
    mockInstanceMethod(store, 'notify');
    mockInstanceMethod(store, 'publish');
    mockDisposableMethod(store, 'retain');
    mockDisposableMethod(store, 'subscribe');
  }

  const mock: MockFunctions = {
    cachePayload,
    clearCache,
    isLoading,
    reject,
    resolve,
    nextValue,
    complete,
    getMostRecentOperation,
    resolveMostRecentOperation(payload): void {
      const operation = getMostRecentOperation();
      const data = typeof payload === 'function' ? payload(operation) : payload;
      return resolve(operation, data);
    },
    rejectMostRecentOperation(error): void {
      const operation = getMostRecentOperation();
      const rejector = typeof error === 'function' ? error(operation) : error;
      return reject(operation, rejector);
    },
    findOperation,
    getAllOperations() {
      return pendingOperations;
    },
    queueOperationResolver,
  };

  // @ts-ignore
  environment.mock = mock;

  // @ts-ignore
  environment.mockClear = () => {
    (environment as any).applyUpdate.mockClear();
    (environment as any).commitPayload.mockClear();
    (environment as any).getStore.mockClear();
    (environment as any).lookup.mockClear();
    (environment as any).check.mockClear();
    (environment as any).subscribe.mockClear();
    (environment as any).retain.mockClear();
    (environment as any).execute.mockClear();
    (environment as any).executeMutation.mockClear();

    store.getSource.mockClear();
    store.lookup.mockClear();
    store.notify.mockClear();
    store.publish.mockClear();
    store.retain.mockClear();
    store.subscribe.mockClear();

    cache.clear();
    pendingOperations = [];
    pendingRequests = [];
  };

  return environment;
}
