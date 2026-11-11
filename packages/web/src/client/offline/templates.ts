/**
 * **The id that names nothing** ([3.18.18](docs/project/prd.md)).
 *
 * A prayer request's page and a Flow Tracker session's page exist once per thing, and the service
 * worker can only keep a page it has fetched. One raised or started offline has an id the device
 * minted a moment ago: the server has never rendered its page, and no cache holds it.
 *
 * Neither page reads anything on the server — each hands its id to a client component that asks
 * the API — so the page for one id is the page for any other with the id swapped. The offline
 * manager has the worker keep each page once under this id, and the worker answers any other id
 * of the same route from that copy with the id replaced (`public/sw/offline.js`, which carries its
 * own copy of this value; `tests/unit/offline-worker.test.ts` holds the two to each other).
 *
 * A valid uuid, so it travels every path a real one does, and the nil-ish pattern makes it
 * recognisable in a cache listing.
 */
export const OFFLINE_PAGE_TEMPLATE_ID = '00000000-0000-4000-8000-00000000000f';
