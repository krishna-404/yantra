import { defineEvent, defineTask, Type } from "pg-tbus";

export const userCreatedEventDef = defineEvent({
	event_name: "user.created",
	schema: Type.Object({
		userId: Type.String({ format: "uuid" }),
		email: Type.String(),
		name: Type.String(),
	}),
});

export const userDeletedEventDef = defineEvent({
	event_name: "user.deleted",
	schema: Type.Object({
		userId: Type.String({ format: "uuid" }),
	}),
});

// One live yantra turn (advise → execute) — queued by the tick after a claim.
// retryLimit 0: §2.3 retry semantics live INSIDE the runner; a tbus re-run
// would double-claim the issue. expireInSeconds covers advise (15 m) +
// execute (2 h) + one in-runner retry with margin.
export const yantraLiveTurnTaskDef = defineTask({
	task_name: "yantra.live_turn",
	schema: Type.Object({
		projectId: Type.String(),
		issue: Type.Number(),
		turn: Type.String(),
	}),
	config: {
		retryLimit: 0,
		expireInSeconds: 5 * 60 * 60,
		keepInSeconds: 604800,
	},
});

// Triggered when API usage reaches the 90% threshold.
export const subscriptionAlertWebhookTaskDef = defineTask({
	task_name: "subscription.alert_webhook",
	schema: Type.Object({
		subscriptionId: Type.String({ pattern: "^[0-9A-Z]{26}$" }),
		teamApiId: Type.String({ format: "uuid" }),
		payload: Type.Object({
			event: Type.Literal("subscription.usage_alert"),
			subscriptionId: Type.String({ pattern: "^[0-9A-Z]{26}$" }),
			teamApiId: Type.String({ format: "uuid" }),
			apiProductSku: Type.String(),
			requestsConsumed: Type.Number(),
			maxRequests: Type.Number(),
			usagePercent: Type.Number(),
			timestamp: Type.Number(),
		}),
	}),
	config: {
		retryLimit: 3,
		retryDelay: 60,
		retryBackoff: true,
		expireInSeconds: 300,
		keepInSeconds: 604800,
	},
});
