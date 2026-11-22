/**
 * Web Worker that runs an experiment off the main thread, so the page stays
 * responsive through thousands of trials. It posts the partial result a few
 * times a second (the chart fills in as it goes) and the full one at the end.
 * Stopping is done by terminating the worker; ExperimentRun's round-robin
 * order means whatever was last posted already covers the whole grid.
 */
import { type Experiment, type ExperimentResult, ExperimentRun } from './batch';

export interface WorkerRequest {
  experiment: Experiment;
}

export type WorkerReply =
  | { type: 'progress'; result: ExperimentResult }
  | { type: 'done'; result: ExperimentResult }
  | { type: 'error'; message: string };

const POST_EVERY_MS = 200;

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(reply: WorkerReply): void;
};

scope.onmessage = (ev) => {
  try {
    const run = new ExperimentRun(ev.data.experiment);
    scope.postMessage({ type: 'progress', result: run.result() });
    let posted = performance.now();
    while (run.step()) {
      const now = performance.now();
      if (now - posted >= POST_EVERY_MS) {
        scope.postMessage({ type: 'progress', result: run.result() });
        posted = now;
      }
    }
    scope.postMessage({ type: 'done', result: run.result() });
  } catch (e) {
    scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
