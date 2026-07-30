import { dbConfig } from "@backend/db/config.db";
import { AccountTable } from "@backend/modules/auth/tables/account.auth.table";
import { SessionTable } from "@backend/modules/auth/tables/session.auth.table";
import { VerificationTable } from "@backend/modules/auth/tables/verification.auth.table";
import { PgTbusTaskLogTable } from "@backend/modules/events/tables/pg_tbus_task_log.table";
import { FileTable } from "@backend/modules/files/tables/files.table";
import { ApiProductRequestLogsTable } from "@backend/modules/logs/tables/api_product_request_logs.table";
import { PushDeviceTable } from "@backend/modules/notifications/tables/push_devices.table";
import { SubscriptionsTable } from "@backend/modules/subscriptions/tables/subscriptions.table";
import { FeatureFlagTable } from "@backend/modules/system/tables/feature_flags.table";
import { RateLimitTable } from "@backend/modules/system/tables/rate_limits.table";
import { TeamMemberTable } from "@backend/modules/teams/tables/team_members.table";
import { TeamApiTable } from "@backend/modules/teams/tables/teams_api.table";
import { TeamAppTable } from "@backend/modules/teams/tables/teams_app.table";
import { UserTable } from "@backend/modules/users/tables/users.table";
import { YantraAppSecretTable } from "@backend/modules/yantra/tables/yantra_app_secrets.table";
import { YantraProjectTable } from "@backend/modules/yantra/tables/yantra_projects.table";
import { YantraRoutineTable } from "@backend/modules/yantra/tables/yantra_routines.table";
import { YantraRunTable } from "@backend/modules/yantra/tables/yantra_runs.table";
import { YantraTelemetryTable } from "@backend/modules/yantra/tables/yantra_telemetry.table";
import { YantraTurnTable } from "@backend/modules/yantra/tables/yantra_turns.table";
import { YantraVerdictTable } from "@backend/modules/yantra/tables/yantra_verdicts.table";
import { orchidORM } from "orchid-orm/node-postgres";

export const db = orchidORM(
	{
		...dbConfig,
		log: false,
	},
	{
		users: UserTable,
		teamsApp: TeamAppTable,
		teamMembers: TeamMemberTable,
		files: FileTable,

		// API only
		teamsApi: TeamApiTable,
		subscriptions: SubscriptionsTable,
		apiProductRequestLogs: ApiProductRequestLogsTable,

		// Backend only
		sessions: SessionTable,
		accounts: AccountTable,
		verifications: VerificationTable,
		pgTbusTaskLogs: PgTbusTaskLogTable,
		featureFlags: FeatureFlagTable,
		rateLimits: RateLimitTable,
		pushDevices: PushDeviceTable,

		// Yantra harness state (Phase 2, H1) — the factory's own tables.
		yantraAppSecrets: YantraAppSecretTable,
		yantraProjects: YantraProjectTable,
		yantraRoutines: YantraRoutineTable,
		yantraTurns: YantraTurnTable,
		yantraRuns: YantraRunTable,
		yantraVerdicts: YantraVerdictTable,
		yantraTelemetry: YantraTelemetryTable,
	},
);

export type Db = typeof db;
