import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { runtime$ } from "./runtime.mjs";
import { WORKER_THREAD } from "./symbols.mjs";

export function createWorker(url) {
  const worker = new Worker(url);
  runtime$(WORKER_THREAD, worker);

  const workerMap = new Map();
  worker.on(
    "message",
    ({ id, stream, postponed, start, done, error, stack }) => {
      if (id) {
        if (error) {
          const err = new Error(error);
          err.stack = stack;
          workerMap.get(id)?.onError?.(err);
          workerMap.delete(id);
        } else if (stream) {
          workerMap.get(id).resolve(stream);
        } else if (start) {
          workerMap.get(id).start({ id });
        } else if (postponed) {
          workerMap.get(id).onPostponed?.(postponed);
        } else if (done) {
          workerMap.delete(id);
        }
      }
    }
  );

  return async ({
    start,
    onError,
    onPostponed,
    stream,
    prelude,
    ...options
  }) => {
    const id = randomUUID();
    const promise = new Promise((resolve, reject) =>
      workerMap.set(id, { resolve, reject, start, onError, onPostponed })
    );
    if (prelude) {
      worker.postMessage({ id, stream, prelude, ...options }, [
        stream,
        prelude,
      ]);
    } else {
      worker.postMessage({ id, stream, ...options }, [stream]);
    }
    return promise;
  };
}
