/* CAC Goodworks Audio Translator — one shared AI worker for the current job.
 * The worker (and the memory its models use) is released when a job ends unless the
 * "keep models loaded" setting is on.
 */
import { WorkerClient } from './ml-client.js';

let shared = null;

export function acquireClient() {
  if (!shared) shared = new WorkerClient('job');
  return shared;
}

/** Ends the worker and frees its memory. Pass keep=true to leave it running for the next job. */
export function releaseClient(keep = false) {
  if (keep || !shared) return;
  shared.terminate();
  shared = null;
}

/** Immediately stops whatever the worker is doing (used by Cancel). */
export function abortClient() {
  if (!shared) return;
  shared.terminate();
  shared = null;
}
