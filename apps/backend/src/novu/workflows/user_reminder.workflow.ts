import { workflow } from "@novu/framework";

/**
 * Daily user reminder — triggered by the reminder-dispatch cron
 * (apps/backend/src/cron_jobs/reminder_dispatch.cron.ts) when a user's
 * configured reminder times match the current minute in their timezone.
 *
 * Push step fires an OS notification (if the user has push enabled);
 * In-app step is always visible in the Inbox bell regardless of push.
 * Both steps use the same payload shape (`title`, `body`) so the trigger
 * caller doesn't need to know channel-specific fields.
 */
export const userReminderWorkflow = workflow(
	"user-reminder",
	async ({ step, payload }) => {
		await step.push("send-push", async () => ({
			subject: payload.title,
			body: payload.body,
		}));

		await step.inApp("send-in-app", async () => ({
			subject: payload.title,
			body: payload.body,
			redirect: { url: "/" },
		}));
	},
	{
		payloadSchema: {
			type: "object",
			properties: {
				title: { type: "string", default: "Daily reminder ✍️" },
				body: {
					type: "string",
					default: "Take a moment for your daily check-in.",
				},
			},
			required: ["title", "body"],
			additionalProperties: false,
		} as const,
		name: "User Reminder",
		description: "Daily reminder at the user's chosen time.",
	},
);
