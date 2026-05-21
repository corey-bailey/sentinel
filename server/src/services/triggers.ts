import { and, eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { testPlans, testRuns } from "@sentinel/db";

export type DeployWebhookInput = {
  repo: string;
  commit: string;
  changedFiles: string[];
};

export function triggerService(db: Db) {
  return {
    async deployWebhook(companyId: string, input: DeployWebhookInput): Promise<{ runIds: string[] }> {
      const plans = await db
        .select()
        .from(testPlans)
        .where(eq(testPlans.companyId, companyId));

      const matchedPlans = plans.filter((plan) => {
        const patterns = (plan.filePatterns as string[]) ?? [];
        if (patterns.length === 0) return true;
        return input.changedFiles.some((file) =>
          patterns.some((pattern) => file.includes(pattern)),
        );
      });

      if (matchedPlans.length === 0) {
        return { runIds: [] };
      }

      const runs = await Promise.all(
        matchedPlans.map((plan) =>
          db
            .insert(testRuns)
            .values({
              companyId,
              testPlanId: plan.id,
              triggerType: "ci",
              triggerContext: { repo: input.repo, commit: input.commit },
              status: "queued",
            })
            .returning()
            .then((rows) => rows[0]!),
        ),
      );

      return { runIds: runs.map((r) => r.id) };
    },
  };
}
