// Queue a pipeline stage for the next scheduler tick.
//
// `pipeline_force_run.stage` is the primary key, which usefully caps the
// queue at one pending run per stage. UPSERT rather than DO NOTHING:
// with args in play (mig 067) a second request carrying *different*
// parameters must replace the first rather than be silently dropped,
// and for a plain run the only thing that moves is requested_at.
//
// Three callers, one shape: a publish queues dispatch so the mail
// doesn't trail the web by up to six hours; /admin/run/:stage queues
// whatever the operator asked for; and a tripped confirmation-send cap
// queues dispatch so the deferred confirmations drain within the hour.

import { db } from "../db/index.ts";

export async function queueForceRun(
  stage: string,
  args: unknown = null,
): Promise<void> {
  const payload = args === null ? null : (JSON.stringify(args) as never);
  await db
    .insertInto("pipeline_force_run")
    .values({ stage, args: payload })
    .onConflict((oc) =>
      oc
        .column("stage")
        .doUpdateSet({ args: payload, requested_at: new Date() }),
    )
    .execute();
}
