# QBWC SOAP Stub (DEV)

## Job queue locking

This stub keeps the work queue in `<LOG_DIR>/jobs.json`. Concurrent writes used to be
able to clobber each other (for example, when QuickBooks was pulling a job at the
same time Shopify pushed a webhook). The queue helpers now guard each mutation with
`withJobsLock(fn)`, which creates `<LOG_DIR>/jobs.lock` using `fs.mkdirSync`. If the
lock already exists, the helper retries after a short `setTimeout` until the lock is
released, then it re-reads `jobs.json`, applies the requested mutation and persists
the updated list with `writeFileSync`.

Because the helpers are asynchronous, `enqueueJob()` and `popJob()` now return
promises. Callers must `await` them to ensure the mutation is flushed to disk before
continuing.

```js
const { enqueueJob, popJob } = require('./services/jobQueue');

await enqueueJob({ type: 'inventoryQuery', ts: new Date().toISOString() });
const next = await popJob();
```

## Manual concurrency validation

You can reproduce the locking behaviour end-to-end with the running stub:

1. Launch the app with a throwaway log directory, for example
   `LOG_DIR=/tmp/qbd-lock-test npm start`.
2. Seed a QuickBooks job (`GET /debug/seed-inventory`) and ensure
   `<LOG_DIR>/last-inventory.json` contains an item that Shopify can match by SKU.
3. Fire both `POST /qbwc` (with a `sendRequestXML` SOAP body) and the
   `POST /shopify/webhooks/orders/paid` webhook at the same time. A minimal Node 18
   script can do this by kicking off both `fetch` calls inside `Promise.all`.
4. Inspect `GET /debug/queue` — the sales receipt job enqueued by Shopify remains
   in the queue while the QuickBooks request receives the inventory query job, so no
   work is lost.

The test script under step 3 is the one used during development to validate the
lock: it seeded the queue, triggered the SOAP request and webhook concurrently, and
verified the `salesReceiptAdd` job persisted in `jobs.json` after both calls
completed.